import express from "express";
import path from "path";
import fs from "fs";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import axios from "axios";
import sharp from "sharp";

dotenv.config({ override: true });

const SAAS_ORIGIN = process.env.SAAS_ORIGIN || 'http://aibigtree.com';

const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]) as Promise<T>;
};

async function readJsonResponse(res: any) {
  const data = res.data;
  if (!data || data.success === false) {
    throw new Error(data?.error || data?.message || `请求失败: ${res.status}`);
  }
  return data;
}

async function verifyBeforeGenerate({ userId, toolId }: { userId: string, toolId: string }) {
  const res = await axios.post(`${SAAS_ORIGIN}/api/tool/verify`, { userId, toolId });
  return readJsonResponse(res);
}

async function saveImageToSaas({
  userId,
  toolId,
  imageBuffer,
  mimeType = 'image/png',
  fileName
}: {
  userId: string,
  toolId: string,
  imageBuffer: Buffer,
  mimeType?: string,
  fileName?: string
}) {
  const saasTimeout = 120000; // 120 seconds
  const finalFileName = fileName || `result-${Date.now()}.png`;

  console.log(`[SaaS Upload] Starting result upload, size: ${imageBuffer.byteLength} bytes`);

  // 1. & 2. Parallellize Point Consumption and Direct Token request
  const consumeTask = axios.post(`${SAAS_ORIGIN}/api/tool/consume`, { userId, toolId }, { timeout: saasTimeout });
  const tokenTask = axios.post(`${SAAS_ORIGIN}/api/upload/direct-token`, {
    userId,
    toolId,
    source: 'result',
    mimeType,
    fileName: finalFileName,
    fileSize: imageBuffer.byteLength
  }, { timeout: saasTimeout });

  const [consumeRes, tokenRes] = await Promise.all([consumeTask, tokenTask]);
  
  await readJsonResponse(consumeRes);
  const token = await readJsonResponse(tokenRes);

  console.log(`[SaaS Upload] Got token, uploading to OSS...`);

  // 3. PUT to OSS using token headers
  const uploadRes = await axios.put(token.uploadUrl, imageBuffer, {
    headers: { 
      ...(token.headers || {}), 
      'Content-Type': mimeType 
    },
    timeout: saasTimeout,
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  });
  
  if (uploadRes.status < 200 || uploadRes.status >= 300) {
    throw new Error(`OSS 上传失败: ${uploadRes.status}`);
  }

  console.log(`[SaaS Upload] OSS upload success, committing...`);

  // 4. Commit
  const commitRes = await axios.post(`${SAAS_ORIGIN}/api/upload/commit`, {
    userId,
    toolId,
    source: 'result',
    objectKey: token.objectKey,
    fileName: finalFileName,
    fileSize: imageBuffer.byteLength
  }, { timeout: saasTimeout });
  const commitResult = await readJsonResponse(commitRes);
  console.log(`[SaaS Upload] Commit success`);

  if (!commitResult.savedToRecords) {
    throw new Error(commitResult.error || '图片入库失败');
  }

  return commitResult.image || commitResult;
}

function getGeminiApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key.trim() === "") {
    throw new Error("GEMINI_API_KEY is missing. Please set it in the Environment Variables (Settings -> Secrets).");
  }
  
  // Clean the key: remove any surrounding quotes, whitespace, or newlines
  const cleanedKey = key.trim().replace(/^["']|["']$/g, '').trim();
  
  if (cleanedKey.length < 20) {
    throw new Error("GEMINI_API_KEY seems too short or malformed. Please check your key.");
  }
  
  return cleanedKey;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Increase the payload size limit for base64 images to 50mb
  app.use(express.json({ limit: '50mb' }));

  // SaaS Proxy logic
  const proxyRequest = async (req: express.Request, res: express.Response, targetPath: string) => {
    const targetUrl = `${SAAS_ORIGIN}${targetPath}`;
    try {
      const response = await axios({
        method: req.method,
        url: targetUrl,
        data: req.body,
        headers: { 'Content-Type': 'application/json' }
      });
      res.status(response.status).json(response.data);
    } catch (error: any) {
      console.error(`Proxy error (silenced) for ${targetPath}:`, error.message);
      // For upload paths, don't return 500 if user doesn't want errors for uploads
      if (targetPath.includes('/api/upload/')) {
        return res.status(200).json({ success: false, silenced: true });
      }
      res.status(500).json({ success: false, error: "代理转发失败" });
    }
  };

  app.post("/api/tool/launch", (req, res) => proxyRequest(req, res, "/api/tool/launch"));
  app.post("/api/tool/verify", (req, res) => proxyRequest(req, res, "/api/tool/verify"));
  app.post("/api/tool/consume", (req, res) => proxyRequest(req, res, "/api/tool/consume"));
  app.post("/api/upload/direct-token", (req, res) => proxyRequest(req, res, "/api/upload/direct-token"));
  app.post("/api/upload/commit", (req, res) => proxyRequest(req, res, "/api/upload/commit"));

  // API routes
  app.post("/api/analyze", async (req, res) => {
    try {
      const { base64Image, imageUrl, mimeType, userId, toolId } = req.body;

      // Verify points if SaaS info is provided
      if (userId && toolId && userId !== 'null' && toolId !== 'null') {
        try {
          await verifyBeforeGenerate({ userId, toolId });
        } catch (error: any) {
          return res.status(403).json({ success: false, error: error.message });
        }
      }

      let dataToUse = base64Image;
      let mimeToUse = mimeType;

      if (imageUrl && !base64Image) {
        const fetchRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        dataToUse = Buffer.from(fetchRes.data).toString('base64');
        mimeToUse = fetchRes.headers['content-type'] || 'image/jpeg';
      }

      const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
      const analysisPromise = ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            inlineData: {
              data: dataToUse,
              mimeType: mimeToUse,
            },
          },
          {
            text: "Analyze this restaurant image. Identify the layout, decor style, and specific points that need beautification. CRITICAL RULES for beautification points: 1. You MUST generate specific, descriptive beautification points for at least these three mandatory areas: Walls (墙面), Floors (地面), and Tables (桌面). 2. IN ADDITION to those three, you MUST also add other beautification points based on your visual analysis of the image (e.g., ceiling, windows, specific clutter, etc.). 3. Each point MUST be short (under 20 characters). 4. DO NOT alter, add, or remove existing objects. 5. Recommend 3-5 new decorative items to add (e.g., wall art, plants, tissue boxes) to enhance the atmosphere. Also recommend a lighting effect from ['暖色调', '清新浅色', '高端暗色'] and explain why. ALL OUTPUT MUST BE IN CHINESE (简体中文). Return the result in JSON format.",
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              layout: {
                 type: Type.STRING,
                description: "餐厅布局描述 (中文)",
              },
              style: {
                type: Type.STRING,
                description: "装修风格描述 (中文)",
              },
              beautifyPoints: {
                type: Type.ARRAY,
                items: {
                  type: Type.STRING,
                },
                description: "需要美化的具体点列表 (中文，每条不超过20字，不改变原有物品，墙面可增白/修复)",
              },
              recommendedLighting: {
                type: Type.STRING,
                description: "推荐的光影效果，必须是 '暖色调', '清新浅色', 或 '高端暗色' 之一",
              },
              lightingReason: {
                type: Type.STRING,
                description: "为什么推荐这个光影效果的理由 (中文)",
              },
              recommendedAdditions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    item: { type: Type.STRING, description: "推荐添加的物品名称 (中文，例如：墙面挂画、桌面绿植、餐巾盒)" },
                    reason: { type: Type.STRING, description: "推荐理由 (中文)" }
                  },
                  required: ["item", "reason"]
                },
                description: "推荐添加的装饰物品列表 (3-5个)"
              }
            },
            required: ["layout", "style", "beautifyPoints", "recommendedLighting", "lightingReason", "recommendedAdditions"],
          },
        },
      });

      const response = await withTimeout(analysisPromise, 300000, "AI 处理超时(300s)");
      const text = response.text;
      if (!text) {
        throw new Error("No response from AI");
      }
      
      const result = JSON.parse(text);
      res.json(result);
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/beautify", async (req, res) => {
    const totalStart = Date.now();
    try {
      const { base64Image, imageUrl, mimeType, analysis, options, allowAdditions, userId, toolId } = req.body;
      
      // Step 2: Verify points if SaaS info is provided
      if (userId && toolId && userId !== 'null' && toolId !== 'null') {
        const verifyStart = Date.now();
        try {
          await verifyBeforeGenerate({ userId, toolId });
          console.log(`[Beautify] Verify points took ${Date.now() - verifyStart}ms`);
        } catch (error: any) {
          return res.status(403).json({ success: false, error: error.message });
        }
      }

      const getOrigStart = Date.now();
      let dataToUse = base64Image;
      let mimeToUse = mimeType;

      if (imageUrl && !base64Image) {
        const fetchRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        dataToUse = Buffer.from(fetchRes.data).toString('base64');
        mimeToUse = fetchRes.headers['content-type'] || 'image/jpeg';
        console.log(`[Beautify] Fetch original image took ${Date.now() - getOrigStart}ms`);
      }

      const geminiStart = Date.now();
      const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
      
      const additionsToApply = allowAdditions && analysis.recommendedAdditions
        ? analysis.recommendedAdditions.filter((a: any) => a.enabled).map((a: any) => a.item)
        : [];

      const additionRules = additionsToApply.length > 0
        ? `NEW ADDITIONS (CRITICAL): You MUST add the following items naturally into the scene:\n${additionsToApply.map((item: any, i: number) => `${i + 1}. ${item}`).join('\n')}\nDo not add anything else besides these.`
        : `CRITICAL: DO NOT add any new objects, decorations, plants, or items that did not exist in the original image.`;

      const prompt = `You are a top-tier professional photo editor and interior designer. Your task is to renovate and beautify this restaurant image strictly according to the user's specific requests.
      
CRITICAL INSTRUCTION: You MUST execute EVERY SINGLE ONE of the following beautification requests. Do not skip any.
USER'S BEAUTIFICATION POINTS:
${analysis.beautifyPoints.map((p: string, i: number) => `${i + 1}. ${p}`).join('\n')}

MANDATORY BASELINE (ALWAYS APPLY):
- FLOORS: The floor MUST be completely renovated, spotless, and look brand new. Erase all dirt, stains, dark patches, and damage. It should look like newly installed, premium flooring. Absolutely no dirty spots allowed.
- TABLES: Remove all irrelevant clutter from the tables (e.g., used bowls, plates, payment QR codes). Keep existing essential items like tissue boxes and condiment/vinegar bottles, but arrange them neatly and orderly.
- ATMOSPHERE: Apply a "${options.lighting}" lighting effect to make the space look inviting and match the requested mood.
- RESOLUTION & QUALITY: Generate a high quality image with clean details and natural realistic result at ${options.resolution} resolution.

${additionRules}

GENERAL CONSTRAINTS:
- CRITICAL STRUCTURAL RULE: DO NOT change the structural layout of the room under any circumstances. ABSOLUTELY NO adding new windows, NO adding new doors, and NO changing the architectural structure (walls, ceilings, pillars). You are ONLY allowed to do soft furnishings, cleaning, and surface renovations.
- Keep the main furniture (tables, chairs, kitchen equipment) in their original positions, but you can clean, repair, and polish them as requested.
- Make the final image look highly realistic, spotless, and premium.`;

      const beautifyPromise = ai.models.generateContent({
        model: "gemini-3.1-flash-image-preview",
        contents: {
          parts: [
            {
              inlineData: {
                data: dataToUse,
                mimeType: mimeToUse,
              },
            },
            {
              text: prompt,
            },
          ],
        },
        config: {
          imageConfig: {
            aspectRatio: options.ratio,
            imageSize: options.resolution,
          }
        }
      });

      const response = await withTimeout(beautifyPromise, 300000, "AI 处理超时(300s)");
      console.log(`[Beautify] Gemini generation took ${Date.now() - geminiStart}ms`);

      let generatedBase64 = null;
      let generatedMimeType = "image/png";
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          generatedBase64 = part.inlineData.data;
          generatedMimeType = part.inlineData.mimeType || "image/png";
          break;
        }
      }

      if (!generatedBase64) {
        throw new Error("No image generated by AI");
      }

      const sharpStart = Date.now();
      // Step 7: Internal image processing (Sharp) - minimal processing to keep quality
      let imageBuffer = Buffer.from(generatedBase64, 'base64');
      
      imageBuffer = await sharp(imageBuffer)
        .rotate() 
        .toBuffer();

      generatedMimeType = "image/png";
      console.log(`[Beautify] Sharp processing (rotate only) took ${Date.now() - sharpStart}ms`);

      const resultBase64 = `data:${generatedMimeType};base64,${imageBuffer.toString('base64')}`;

      // Save result to SaaS (Must Await)
      let saasImage = null;
      if (userId && toolId && userId !== 'null' && toolId !== 'null') {
        const saasStart = Date.now();
        try {
          saasImage = await saveImageToSaas({
            userId,
            toolId,
            imageBuffer,
            mimeType: generatedMimeType,
            fileName: `beautified-${Date.now()}.jpg`
          });
          console.log(`[Beautify] SaaS save took ${Date.now() - saasStart}ms`);
        } catch (saveError: any) {
          console.error('[Beautify] SaaS save failed:', saveError.message);
          return res.status(500).json({ success: false, error: `图片保存失败: ${saveError.message}` });
        }
      }

      console.log(`[Beautify] Total processing time: ${Date.now() - totalStart}ms`);
      return res.json({ 
        success: true, 
        generatedImage: resultBase64,
        image: saasImage
      });
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    // Support Express v4 default setup
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

import express from "express";
import path from "path";
import fs from "fs";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import axios from "axios";
import sharp from "sharp";

dotenv.config({ override: true });

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

  // Increase the payload size limit for base64 images to 50mb (Safe for large high-res generated images)
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // SaaS Proxy logic
  const proxyRequest = async (req: express.Request, res: express.Response, targetPath: string) => {
    const targetUrl = `http://aibigtree.com${targetPath}`;
    try {
      const response = await axios({
        method: req.method,
        url: targetUrl,
        data: req.body,
        headers: { 'Content-Type': 'application/json' }
      });
      res.status(response.status).json(response.data);
    } catch (error: any) {
      console.error(`Proxy error for ${targetPath}:`, error.message);
      // Try to read response data if possible
      const errorData = error.response?.data || { error: error.message };
      res.status(error.response?.status || 500).json(errorData);
    }
  };

  /**
   * Image normalization (Section 6)
   */
  async function normalizeInputImage(inputBuffer: Buffer) {
    return sharp(inputBuffer, { failOn: 'none' })
      .rotate() // Automatic rotation based on EXIF
      .resize({
        width: 2048,
        height: 2048,
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
  }

  app.post("/api/tool/launch", (req, res) => proxyRequest(req, res, "/api/tool/launch"));
  app.post("/api/tool/verify", (req, res) => proxyRequest(req, res, "/api/tool/verify"));
  app.post("/api/tool/consume", (req, res) => proxyRequest(req, res, "/api/tool/consume"));
  app.post("/api/upload/direct-token", (req, res) => proxyRequest(req, res, "/api/upload/direct-token"));
  app.post("/api/upload/commit", (req, res) => proxyRequest(req, res, "/api/upload/commit"));

  /**
   * SaaS Image Save Logic (Helper)
   */
  async function saveResultImageToSaas({
    userId,
    toolId,
    imageBuffer,
    mimeType = 'image/png',
    fileName = 'result.png'
  }: {
    userId: string;
    toolId: string;
    imageBuffer: Buffer;
    mimeType?: string;
    fileName?: string;
  }) {
    const origin = 'http://aibigtree.com';
    
    // 1. Consume
    await axios.post(`${origin}/api/tool/consume`, { userId, toolId });

    // 2. Direct Token
    const tokenRes = await axios.post(`${origin}/api/upload/direct-token`, {
      userId,
      toolId,
      source: 'result',
      mimeType,
      fileName,
      fileSize: imageBuffer.length
    });
    const token = tokenRes.data;

    // 3. PUT to OSS
    await axios.put(token.uploadUrl, imageBuffer, {
      headers: { ...token.headers, 'Content-Type': mimeType }
    });

    // 4. Commit
    const commitRes = await axios.post(`${origin}/api/upload/commit`, {
      userId,
      toolId,
      source: 'result',
      objectKey: token.objectKey,
      fileSize: imageBuffer.length
    });
    
    return commitRes.data.image || commitRes.data;
  }

  app.post("/api/save-saas", async (req, res) => {
    try {
      const { userId, toolId, base64Data, mimeType } = req.body;
      if (!userId || !toolId || !base64Data) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const imageBuffer = Buffer.from(base64Data, 'base64');
      const result = await saveResultImageToSaas({
        userId,
        toolId,
        imageBuffer,
        mimeType: mimeType || 'image/png',
        fileName: `restaurant_${Date.now()}.png`
      });

      res.json({ success: true, ...result });
    } catch (error: any) {
      console.error("Save SaaS Error:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // API routes
  app.post("/api/analyze", async (req, res) => {
    try {
      const { base64Image, mimeType } = req.body;
      
      // Normalize input image (Section 6)
      const inputBuffer = Buffer.from(base64Image, 'base64');
      const normalizedBuffer = await normalizeInputImage(inputBuffer);
      const normalizedBase64 = normalizedBuffer.toString('base64');

      const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            inlineData: {
              data: normalizedBase64,
              mimeType: "image/jpeg",
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
    try {
      const { base64Image, mimeType, analysis, options, allowAdditions } = req.body;
      
      // Normalize input image (Section 6)
      const inputBuffer = Buffer.from(base64Image, 'base64');
      const normalizedBuffer = await normalizeInputImage(inputBuffer);
      const normalizedBase64 = normalizedBuffer.toString('base64');

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

${additionRules}

GENERAL CONSTRAINTS:
- CRITICAL STRUCTURAL RULE: DO NOT change the structural layout of the room under any circumstances. ABSOLUTELY NO adding new windows, NO adding new doors, and NO changing the architectural structure (walls, ceilings, pillars). You are ONLY allowed to do soft furnishings, cleaning, and surface renovations.
- Keep the main furniture (tables, chairs, kitchen equipment) in their original positions, but you can clean, repair, and polish them as requested.
- Make the final image look highly realistic, spotless, and premium.`;

      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-image-preview",
        contents: {
          parts: [
            {
              inlineData: {
                data: normalizedBase64,
                mimeType: "image/jpeg",
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

      let generatedImage = null;
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          generatedImage = `data:${part.inlineData.mimeType || "image/png"};base64,${part.inlineData.data}`;
          break;
        }
      }

      if (!generatedImage) {
        throw new Error("No image generated by AI");
      }

      // Return both full and raw base64
      const [typePart, base64Part] = generatedImage.split(';base64,');
      const genMimeType = typePart ? typePart.replace('data:', '') : "image/png";

      res.json({ 
        generatedImage,
        rawBase64: base64Part || "",
        mimeType: genMimeType
      });
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/gemini", async (req, res) => {
    try {
      const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
      const { model, contents, config } = req.body;
      const result = await ai.models.generateContent({
        model: model || "gemini-pro",
        contents,
        config
      });
      res.json({ text: result.response.text() });
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

import express from "express";
import path from "path";
import fs from "fs";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import axios from "axios";
import sharp from "sharp";

import multer from "multer";
import { v4 as uuidv4 } from "uuid";

dotenv.config({ override: true });

const SAAS_ORIGIN = process.env.SAAS_ORIGIN || 'http://aibigtree.com';

// Task store for background processing
const tasks = new Map<string, {
  status: 'processing' | 'completed' | 'failed';
  progress: number;
  message?: string;
  result?: any;
  error?: string;
}>();

// Configure multer for memory storage
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB limit
});

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

async function uploadToOssOnly({
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
  // 1. Direct Token
  const finalFileName = fileName || `beautified-${Date.now()}.jpg`;
  const tokenRes = await axios.post(`${SAAS_ORIGIN}/api/upload/direct-token`, {
    userId,
    toolId,
    source: 'result',
    mimeType,
    fileName: finalFileName,
    fileSize: imageBuffer.byteLength
  });
  const token = await readJsonResponse(tokenRes);

  // 2. PUT to OSS
  const uploadRes = await axios.put(token.uploadUrl, imageBuffer, {
    headers: { 
      ...(token.headers || {}), 
      'Content-Type': mimeType 
    }
  });
  
  if (uploadRes.status < 200 || uploadRes.status >= 300) {
    throw new Error(`OSS 上传失败: ${uploadRes.status}`);
  }

  return {
    objectKey: token.objectKey,
    fileSize: imageBuffer.byteLength,
    mimeType,
    fileName: finalFileName
  };
}

async function commitSaasResult({
  userId,
  toolId,
  pendingUpload
}: {
  userId: string,
  toolId: string,
  pendingUpload: any
}) {
  // 1. Consume points
  const consumeRes = await axios.post(`${SAAS_ORIGIN}/api/tool/consume`, { userId, toolId });
  await readJsonResponse(consumeRes);

  // 2. Commit
  const commitRes = await axios.post(`${SAAS_ORIGIN}/api/upload/commit`, {
    userId,
    toolId,
    source: 'result',
    objectKey: pendingUpload.objectKey,
    fileName: pendingUpload.fileName,
    fileSize: pendingUpload.fileSize
  });
  const commitResult = await readJsonResponse(commitRes);
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

  // Increase the payload size limit for base64 images to 20mb as per client expectation
  app.use(express.json({ limit: '20mb' }));

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

  // Task-based Beautification Background Worker
  async function runBeautifyTask(taskId: string, params: any, imageBuffer: Buffer, originalMime: string) {
    const { userId, toolId, analysis, options, allowAdditions } = params;
    
    try {
      tasks.set(taskId, { status: 'processing', progress: 10, message: '正在验证积分...' });

      // 1. Verify before everything
      if (userId && toolId && userId !== 'null' && toolId !== 'null') {
        try {
          await verifyBeforeGenerate({ userId, toolId });
        } catch (error: any) {
          tasks.set(taskId, { status: 'failed', progress: 0, error: `资格验证失败: ${error.message}` });
          return;
        }
      }

      tasks.set(taskId, { status: 'processing', progress: 20, message: 'AI 正在生成精修图 (4K)...' });

      // 2. AI Generation
      const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
      const additionsToApply = allowAdditions && analysis.recommendedAdditions
        ? analysis.recommendedAdditions.filter((a: any) => a.enabled).map((a: any) => a.item)
        : [];
      const additionRules = additionsToApply.length > 0
        ? `NEW ADDITIONS (CRITICAL): You MUST add the following items naturally into the scene:\n${additionsToApply.join('\n')}`
        : `CRITICAL: DO NOT add any new objects.`;

      const prompt = `You are a professional restaurant interior designer. Renovate this image.
      USER POINTS: ${analysis.beautifyPoints.join(', ')}
      LIGHTING: ${options.lighting}
      RESOLUTION: ${options.resolution}
      ${additionRules}
      MAINTAIN ORIGINAL STRUCTURE. CLEAN EVERYTHING.`;

      const beautifyPromise = ai.models.generateContent({
        model: "gemini-3.1-flash-image-preview",
        contents: {
          parts: [
            { inlineData: { data: imageBuffer.toString('base64'), mimeType: originalMime } },
            { text: prompt },
          ],
        },
        config: {
          imageConfig: { aspectRatio: options.ratio, imageSize: options.resolution }
        }
      });

      const response = await withTimeout(beautifyPromise, 300000, "AI 处理超时(300s)");
      
      let generatedBase64 = null;
      for (const part of (response as any).candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          generatedBase64 = part.inlineData.data;
          break;
        }
      }

      if (!generatedBase64) throw new Error("AI 未能生成图片");

      tasks.set(taskId, { status: 'processing', progress: 60, message: '正在进行后期处理...' });

      // 3. Sharp Processing (HQ)
      let resultBuffer = Buffer.from(generatedBase64, 'base64');
      resultBuffer = await sharp(resultBuffer)
        .rotate() 
        .jpeg({ quality: 100, chromaSubsampling: '4:4:4', force: true })
        .toBuffer();
      
      const generatedMimeType = "image/jpeg";

      tasks.set(taskId, { status: 'processing', progress: 75, message: '正在保存到 SaaS...' });

      // 4. Save to SaaS (Strict Order: Consume -> Token -> PUT -> Commit)
      if (userId && toolId && userId !== 'null' && toolId !== 'null') {
        const fileName = `beautified-${Date.now()}.jpg`;
        
        // A. Consume points
        const consumeRes = await axios.post(`${SAAS_ORIGIN}/api/tool/consume`, { userId, toolId });
        await readJsonResponse(consumeRes);

        // B. Get token
        const tokenRes = await axios.post(`${SAAS_ORIGIN}/api/upload/direct-token`, {
          userId, toolId, source: 'result', mimeType: generatedMimeType, fileName, fileSize: resultBuffer.byteLength
        });
        const token = await readJsonResponse(tokenRes);

        // C. PUT to OSS
        await axios.put(token.uploadUrl, resultBuffer, {
          headers: { ...(token.headers || {}), 'Content-Type': generatedMimeType }
        });

        // D. Commit
        const commitRes = await axios.post(`${SAAS_ORIGIN}/api/upload/commit`, {
          userId, toolId, source: 'result', objectKey: token.objectKey, fileName, fileSize: resultBuffer.byteLength
        });
        const commit = await readJsonResponse(commitRes);

        if (!commit.savedToRecords) throw new Error('图片保存入库失败');

        tasks.set(taskId, { 
          status: 'completed', 
          progress: 100, 
          result: {
            url: commit.image?.url || commit.url,
            fileName: commit.image?.fileName || fileName,
            fileSize: resultBuffer.byteLength,
            recordId: commit.image?.recordId || commit.recordId
          }
        });
      } else {
        // No SaaS user, just finish with base64 for preview (though user said don't return big base64, but without SaaS we have no URL)
        // In local mode, we might need a local temp URL, but user's goal is SaaS integration.
        tasks.set(taskId, { 
          status: 'completed', 
          progress: 100, 
          result: {
            url: `data:${generatedMimeType};base64,${resultBuffer.toString('base64').substring(0, 500000)}... (Base64 truncated)`,
            previewOnly: true
          }
        });
      }
    } catch (error: any) {
      console.error(`[Task ${taskId}] failed:`, error.message);
      tasks.set(taskId, { status: 'failed', progress: 0, error: error.message });
    }
  }

  // New Task Endpoints
  app.post("/api/beautify-task", upload.single('image'), async (req, res) => {
    try {
      const { paramsJSON } = req.body;
      const params = JSON.parse(paramsJSON);
      const imageBuffer = req.file?.buffer;
      const originalMime = req.file?.mimetype || 'image/jpeg';

      if (!imageBuffer) return res.status(400).json({ success: false, error: '未接收到图片数据' });
      
      const taskId = uuidv4();
      tasks.set(taskId, { status: 'processing', progress: 0, message: '任务已排期' });

      // Start background worker
      runBeautifyTask(taskId, params, imageBuffer, originalMime);

      res.json({ success: true, taskId });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/task-status", (req, res) => {
    const taskId = req.query.taskId as string;
    const task = tasks.get(taskId);
    if (!task) return res.status(404).json({ success: false, error: '任务不存在' });
    res.json({ success: true, ...task });
  });

  // API routes
  app.post("/api/analyze", upload.single('image'), async (req, res) => {
    try {
      const { paramsJSON } = req.body;
      const params = paramsJSON ? JSON.parse(paramsJSON) : (req.body || {});
      const { userId, toolId } = params;
      
      const imageBuffer = req.file?.buffer;
      const mimeType = req.file?.mimetype || 'image/jpeg';

      if (userId && toolId && userId !== 'null' && toolId !== 'null') {
        try { await verifyBeforeGenerate({ userId, toolId }); } catch (error: any) {
          return res.status(403).json({ success: false, error: error.message });
        }
      }

      if (!imageBuffer) return res.status(400).json({ success: false, error: '未接收到图片' });

      const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
      const analysisPromise = ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          { inlineData: { data: imageBuffer.toString('base64'), mimeType } },
          { text: "Analyze this restaurant image. Identify layout, style, and beautify points. Return JSON." },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              layout: { type: Type.STRING },
              style: { type: Type.STRING },
              beautifyPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
              recommendedLighting: { type: Type.STRING },
              lightingReason: { type: Type.STRING },
              recommendedAdditions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    item: { type: Type.STRING },
                    reason: { type: Type.STRING }
                  },
                  required: ["item", "reason"]
                }
              }
            },
            required: ["layout", "style", "beautifyPoints", "recommendedLighting", "lightingReason", "recommendedAdditions"],
          }
        }
      });

      const response = await withTimeout(analysisPromise, 300000, "AI 处理超时(300s)");
      res.json(JSON.parse((response as any).text()));
    } catch (error: any) {
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

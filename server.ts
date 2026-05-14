import express from "express";
import path from "path";
import fs from "fs";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import axios from "axios";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";

dotenv.config({ override: true });

const SAAS_ORIGIN = 'http://aibigtree.com';

function getGeminiApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key.trim() === "") {
    throw new Error("GEMINI_API_KEY is missing. Please set it in the Environment Variables (Settings -> Secrets).");
  }
  const cleanedKey = key.trim().replace(/^["']|["']$/g, '').trim();
  return cleanedKey;
}

const filterIds = (id: any) => {
  if (id === 'null' || id === 'undefined' || !id) return null;
  return String(id);
};

/**
 * Standard SaaS Image Save Flow (Section 8)
 */
async function saveResultImageToSaas({
  userId,
  toolId,
  imageBuffer,
  mimeType = 'image/png'
}: {
  userId: string;
  toolId: string;
  imageBuffer: Buffer;
  mimeType?: string;
}) {
  const uid = filterIds(userId);
  const tid = filterIds(toolId);
  if (!uid || !tid) throw new Error('Invalid UserID or ToolID');

  // 1. Consume
  const consumeRes = await axios.post(`${SAAS_ORIGIN}/api/tool/consume`, { userId: uid, toolId: tid });
  if (!consumeRes.data.success) throw new Error(consumeRes.data.error || '积分扣费确认失败');

  // 2. Direct Token
  const tokenRes = await axios.post(`${SAAS_ORIGIN}/api/upload/direct-token`, {
    userId: uid,
    toolId: tid,
    source: 'result',
    mimeType,
    fileName: `restaurant_${Date.now()}.png`,
    fileSize: imageBuffer.length
  });
  const token = tokenRes.data;

  // 3. PUT to OSS
  await axios.put(token.uploadUrl, imageBuffer, {
    headers: { ...token.headers, 'Content-Type': mimeType }
  });

  // 4. Commit
  const commitRes = await axios.post(`${SAAS_ORIGIN}/api/upload/commit`, {
    userId: uid,
    toolId: tid,
    source: 'result',
    objectKey: token.objectKey,
    fileSize: imageBuffer.length
  });
  
  if (!commitRes.data.success) throw new Error(commitRes.data.error || '图片入库失败');
  return commitRes.data.image || commitRes.data;
}

/**
 * Image normalization (Section 6)
 */
async function normalizeImage(inputBuffer: Buffer) {
  return sharp(inputBuffer, { failOn: 'none' })
    .rotate()
    .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}

// In-memory Task Store (for Task Mode - Section 7)
const taskStore = new Map<string, {
  status: 'processing' | 'success' | 'error';
  result?: any;
  error?: string;
  createdAt: number;
}>();

// Cleanup old tasks every hour
setInterval(() => {
  const now = Date.now();
  for (const [id, task] of taskStore.entries()) {
    if (now - task.createdAt > 3600000) taskStore.delete(id);
  }
}, 3600000);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '20mb' }));

  // SaaS Proxy logic
  const proxyRequest = async (req: express.Request, res: express.Response, targetPath: string) => {
    const targetUrl = `${SAAS_ORIGIN}${targetPath}`;
    try {
      const body = { ...req.body };
      if (body.userId) body.userId = filterIds(body.userId);
      if (body.toolId) body.toolId = filterIds(body.toolId);

      const response = await axios({
        method: req.method,
        url: targetUrl,
        data: body,
        headers: { 'Content-Type': 'application/json' }
      });
      res.status(response.status).json(response.data);
    } catch (error: any) {
      console.error(`Proxy error for ${targetPath}:`, error.message);
      res.status(500).json({ success: false, error: "集成通讯异常" });
    }
  };

  app.post("/api/tool/launch", (req, res) => proxyRequest(req, res, "/api/tool/launch"));
  app.post("/api/tool/verify", (req, res) => proxyRequest(req, res, "/api/tool/verify"));
  app.post("/api/tool/consume", (req, res) => proxyRequest(req, res, "/api/tool/consume"));

  app.post("/api/analyze", async (req, res) => {
    try {
      const { base64Image } = req.body;
      const inputBuffer = Buffer.from(base64Image, 'base64');
      const normalizedBuffer = await normalizeImage(inputBuffer);
      const normalizedBase64 = normalizedBuffer.toString('base64');

      const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          { inlineData: { data: normalizedBase64, mimeType: "image/jpeg" } },
          { text: "Analyze this restaurant image. Identify the layout, decor style, and specific points that need beautification. CRITICAL RULES: 1. Focus on Walls (墙面), Floors (地面), and Tables (桌面). 2. For Tables, suggest items like vinegar bottles or tissue boxes for staging. 3. Identify ground trash, trash cans, or people for removal. 4. DO NOT suggest structural changes or text changes. ALL OUTPUT IN CHINESE. Return JSON." },
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
      res.json(JSON.parse(response.text));
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: error.message });
    }
  });

  // Task Mode Implementation for Beautify
  app.post("/api/beautify", async (req, res) => {
    const taskId = uuidv4();
    taskStore.set(taskId, { status: 'processing', createdAt: Date.now() });

    // Return taskId immediately - Thoroughly solves 504 Time-out
    res.json({ taskId });

    // Background Execution
    (async () => {
      try {
        const { base64Image, analysis, options, allowAdditions } = req.body;
        const inputBuffer = Buffer.from(base64Image, 'base64');
        const normalizedBuffer = await normalizeImage(inputBuffer);
        const normalizedBase64 = normalizedBuffer.toString('base64');

        const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
        const additionsToApply = allowAdditions && analysis.recommendedAdditions
          ? analysis.recommendedAdditions.filter((a: any) => a.enabled).map((a: any) => a.item)
          : [];

        const additionRules = additionsToApply.length > 0
          ? `NEW ADDITIONS: You MUST add these itemsNaturally: ${additionsToApply.join(', ')}.`
          : `DO NOT add any new decoration items.`;

        const prompt = `Refurbish this restaurant image. Points: ${analysis.beautifyPoints.join(', ')}. 
        1. Clean walls/floors. 2. Remove trash/clutter/people. 3. Apply "${options.lighting}" lighting. 
        4. NEVER change structure or text. ${additionRules}`;

        const response = await ai.models.generateContent({
          model: "gemini-3.1-flash-image-preview",
          contents: {
            parts: [
              { inlineData: { data: normalizedBase64, mimeType: "image/jpeg" } },
              { text: prompt },
            ],
          },
          config: {
            imageConfig: { aspectRatio: options.ratio, imageSize: options.resolution }
          }
        });

        let genBase64 = null;
        let genMime = "image/png";
        for (const part of response.candidates?.[0]?.content?.parts || []) {
          if (part.inlineData) {
            genBase64 = part.inlineData.data;
            genMime = part.inlineData.mimeType || "image/png";
            break;
          }
        }

        if (!genBase64) throw new Error("AI failed to generate image");

        taskStore.set(taskId, {
          status: 'success',
          createdAt: Date.now(),
          result: {
            generatedImage: `data:${genMime};base64,${genBase64}`,
            rawBase64: genBase64,
            mimeType: genMime
          }
        });
      } catch (error: any) {
        console.error('Task Error:', error.message);
        taskStore.set(taskId, {
          status: 'error',
          error: error.message,
          createdAt: Date.now()
        });
      }
    })();
  });

  app.get("/api/task-status", (req, res) => {
    const { taskId } = req.query;
    if (!taskId || typeof taskId !== 'string') return res.status(400).json({ error: 'Missing taskId' });
    const task = taskStore.get(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  });

  app.post("/api/save-saas", async (req, res) => {
    try {
      const { userId, toolId, base64Data, mimeType } = req.body;
      const result = await saveResultImageToSaas({
        userId,
        toolId,
        imageBuffer: Buffer.from(base64Data, 'base64'),
        mimeType
      });
      res.json({ success: true, ...result });
    } catch (error: any) {
      console.error('Save SaaS Error:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Vite setup
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
}

startServer();


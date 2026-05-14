import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenAI, Type } from "@google/genai";
import sharp from 'sharp';

function getGeminiApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key.trim() === "") return "";
  return key.trim().replace(/^["']|["']$/g, '').trim();
}

const SAAS_ORIGIN = 'http://aibigtree.com';

// In-memory task storage for Cloud Run (short-lived polling)
const taskStore = new Map<string, {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  data?: any;
  error?: string;
  timestamp: number;
}>();

// Cleanup old tasks periodically (every 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [id, task] of taskStore.entries()) {
    if (now - task.timestamp > 1000 * 60 * 15) { // 15 mins
      taskStore.delete(id);
    }
  }
}, 1000 * 60 * 10);

/**
 * Robust JSON response reader to handle HTML error pages or malformed JSON
 */
async function readJsonResponse(res: Response) {
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 300) || 'Unknown non-JSON error' };
  }

  if (!res.ok || data.success === false) {
    throw new Error(data.error || data.message || `Request failed with status ${res.status}`);
  }

  return data;
}

const filterIds = (id: any) => {
  if (id === 'null' || id === 'undefined' || !id) return null;
  return String(id);
};

const allowCors = (fn: any) => async (req: VercelRequest, res: VercelResponse) => {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  return await fn(req, res);
};

/**
 * Image normalization (Section 6)
 */
async function normalizeInputImage(inputBuffer: Buffer) {
  return sharp(inputBuffer, { failOn: 'none' })
    .rotate() // Automatic rotation based on EXIF
    .resize({
      width: 1280, // Optimized from 2048 to 1280/1536 as requested
      height: 1280,
      fit: 'inside',
      withoutEnlargement: true
    })
    .jpeg({ quality: 80, mozjpeg: true }) // Quality around 0.8 as requested
    .toBuffer();
}

const handler = async (req: VercelRequest, res: VercelResponse) => {
  const url = req.url || '';

  try {
    // 1. Local Task Polling (High priority)
    if (url.includes('/api/tasks/')) {
      const pathPart = url.split('?')[0];
      const taskId = pathPart.split('/').pop();
      console.log(`[Polling] TaskId: ${taskId}`);
      
      if (!taskId) return res.status(400).json({ error: 'Missing taskId' });
      
      const task = taskStore.get(taskId);
      if (!task) return res.status(404).json({ error: 'Task not found or expired' });
      
      return res.status(200).json(task);
    }

    // 2. Analyze Image
    if (url.includes('/api/analyze')) {
      const { base64Image, mimeType } = req.body;
      const inputBuffer = Buffer.from(base64Image, 'base64');
      const normalizedBuffer = await normalizeInputImage(inputBuffer);
      const normalizedBase64 = normalizedBuffer.toString('base64');

      const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          { inlineData: { data: normalizedBase64, mimeType: "image/jpeg" } },
          { text: "Analyze this restaurant image. Identify the layout, decor style, and specific points that need beautification. Return JSON in Chinese." },
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
      return res.status(200).json(JSON.parse(response.text));
    }

    // 3. Beautify Image (Task-based to avoid 504)
    if (url.includes('/api/beautify')) {
      const { base64Image, analysis, options, allowAdditions } = req.body;
      const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

      taskStore.set(taskId, { status: 'pending', timestamp: Date.now() });

      // Run AI in background
      (async () => {
        try {
          taskStore.set(taskId, { ...taskStore.get(taskId)!, status: 'processing' });
          const inputBuffer = Buffer.from(base64Image, 'base64');
          const normalizedBuffer = await normalizeInputImage(inputBuffer);
          const normalizedBase64 = normalizedBuffer.toString('base64');

          const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
          
          const additionsToApply = allowAdditions && analysis.recommendedAdditions
            ? analysis.recommendedAdditions.filter((a: any) => a.enabled).map((a: any) => a.item)
            : [];

          const additionRules = additionsToApply.length > 0
            ? `NEW ADDITIONS: ${additionsToApply.join(', ')}`
            : `DO NOT add new objects.`;

          const prompt = `Restoration expert mode. Refurbish based on: ${analysis.beautifyPoints.join(', ')}. Lighting: ${options.lighting}. ${additionRules}`;
          
          const response = await ai.models.generateContent({
            model: "gemini-3.1-flash-image-preview",
            contents: {
              parts: [
                { inlineData: { data: normalizedBase64, mimeType: "image/jpeg" } },
                { text: prompt },
              ],
            },
            config: {
              imageConfig: {
                aspectRatio: options.ratio,
                imageSize: options.resolution,
              }
            }
          });

          let generatedImageBase64 = null;
          let generatedMimeType = "image/png";
          for (const part of response.candidates?.[0]?.content?.parts || []) {
            if (part.inlineData) {
              generatedImageBase64 = part.inlineData.data;
              generatedMimeType = part.inlineData.mimeType || "image/png";
              break;
            }
          }

          if (!generatedImageBase64) throw new Error("AI failed to generate image");

          taskStore.set(taskId, {
            status: 'completed',
            timestamp: Date.now(),
            data: {
              generatedImage: `data:${generatedMimeType};base64,${generatedImageBase64}`,
              rawBase64: generatedImageBase64,
              mimeType: generatedMimeType
            }
          });
        } catch (err: any) {
          taskStore.set(taskId, { status: 'failed', timestamp: Date.now(), error: err.message });
        }
      })();

      return res.status(200).json({ success: true, taskId });
    }

    // 4. SaaS Proxy Fallback
    if (url.includes('/api/tool/') || url.includes('/api/upload/')) {
      const targetUrl = `${SAAS_ORIGIN}${url}`;
      const payload = { ...req.body };
      if (payload.userId) payload.userId = filterIds(payload.userId);
      if (payload.toolId) payload.toolId = filterIds(payload.toolId);

      const response = await fetch(targetUrl, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : JSON.stringify(payload),
      });
      
      const data = await readJsonResponse(response);
      return res.status(200).json(data);
    }

    // 5. Gemini General
    if (url.includes('/api/gemini')) {
      const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
      const { model, contents, config } = req.body;
      const result = await ai.models.generateContent({ model: model || "gemini-pro", contents, config });
      return res.status(200).json({ text: result.text });
    }

    return res.status(404).json({ error: 'Endpoint not found' });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
};

export default allowCors(handler);

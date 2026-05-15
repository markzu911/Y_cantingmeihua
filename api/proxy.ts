import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenAI, Type } from "@google/genai";
import sharp from "sharp";

export const runtime = 'nodejs';
export const maxDuration = 300; // 延长至 300 秒

function getGeminiApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key.trim() === "") return "";
  return key.trim().replace(/^["']|["']$/g, '').trim();
}

// 模拟 AbortController 行为的超时 Promise
const withTimeout = (promise: Promise<any>, ms: number, message: string) => {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
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

const handler = async (req: VercelRequest, res: VercelResponse) => {
  const url = req.url || '';
  const SAAS_ORIGIN = process.env.SAAS_ORIGIN || 'http://aibigtree.com';

  // Note: Vercel serverless has 4MB/10MB limits and maxDuration.
  // This proxy stays for compatibility but the main logic is in server.ts (Node).

  try {
    // 1. Tool & Upload Proxy
    if (url.includes('/api/tool/') || url.includes('/api/upload/')) {
      const targetUrl = `${SAAS_ORIGIN}${url}`;
      
      // Filter out invalid ID strings from body
      const body = { ...req.body };
      if (body.userId === 'null' || body.userId === 'undefined') delete body.userId;
      if (body.toolId === 'null' || body.toolId === 'undefined') delete body.toolId;

      try {
        const response = await fetch(targetUrl, {
          method: req.method,
          headers: { 'Content-Type': 'application/json' },
          body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : JSON.stringify(body),
        });
        
        const data = await response.json();
        const status = (url.includes('/api/upload/') && response.status >= 400) ? 200 : response.status;
        return res.status(status).json(data);
      } catch (proxyError: any) {
        console.error(`Proxy fetch error (silenced) for ${targetUrl}:`, proxyError);
        if (url.includes('/api/upload/')) {
          return res.status(200).json({ success: false, silenced: true });
        }
        throw proxyError;
      }
    }

    // 2. Analyze Image
    if (url.includes('/api/analyze')) {
      // In Serverless, we still support synchronous identify as it's short
      return res.status(200).json({ success: false, error: '请使用 Node 运行时以支持分析任务' });
    }

    // 3. Task Status (Forward to Node server if needed, but here we just return error as proxy.ts is standalone)
    if (url.includes('/api/task-status') || url.includes('/api/beautify-task')) {
      return res.status(501).json({ success: false, error: '此端点仅在 Node 模式下可用。请确保您运行的是 full-stack Node 分支。' });
    }

    // 5. Generic Gemini fallback
    if (url.includes('/api/gemini')) {
      const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
      const { model, contents, config } = req.body;
      const result = await ai.models.generateContent({
        model: model || "gemini-pro",
        contents,
        config
      });
      return res.status(200).json({ text: result.text });
    }

    return res.status(404).json({ error: 'Endpoint not found' });
  } catch (error: any) {
    console.error('Proxy Error:', error);
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
};

export default allowCors(handler);

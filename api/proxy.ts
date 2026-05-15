import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenAI, Type } from "@google/genai";

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

  // Helper to save result image to SaaS following the standard flow
  const saveResultImageToSaas = async (userId: string, toolId: string, imageBuffer: Buffer, mimeType: string = 'image/png') => {
    if (userId === 'null' || userId === 'undefined' || !userId) throw new Error('Invalid User ID');
    if (toolId === 'null' || toolId === 'undefined' || !toolId) throw new Error('Invalid Tool ID');

    // 1. Consume points (Confirmed success)
    const consumeRes = await fetch(`${SAAS_ORIGIN}/api/tool/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, toolId })
    });
    const consumeText = await consumeRes.text();
    let consume;
    try { consume = JSON.parse(consumeText); } catch { consume = { success: false, error: consumeText }; }
    
    if (!consume.success) throw new Error(consume.error || consume.message || '积分扣费失败');

    // 2. Direct Token
    const finalFileName = `beautified-${Date.now()}.jpg`;
    const tokenRes = await fetch(`${SAAS_ORIGIN}/api/upload/direct-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        toolId,
        source: 'result',
        mimeType,
        fileName: finalFileName,
        fileSize: imageBuffer.length
      })
    });
    const token = await tokenRes.json();
    if (!token.success) throw new Error(token.error || '获取上传凭证失败');

    // 3. PUT to OSS using token headers
    const uploadRes = await fetch(token.uploadUrl, {
      method: token.method || 'PUT',
      headers: {
        ...(token.headers || {}),
        'Content-Type': mimeType
      },
      body: imageBuffer
    });
    if (!uploadRes.ok) throw new Error(`OSS 上传失败: ${uploadRes.status}`);

    // 4. Commit
    const commitRes = await fetch(`${SAAS_ORIGIN}/api/upload/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        toolId,
        source: 'result',
        objectKey: token.objectKey,
        fileName: finalFileName,
        fileSize: imageBuffer.length
      })
    });
    const commitResult = await commitRes.json();
    if (!commitResult.savedToRecords) throw new Error(commitResult.error || '图片入库失败');

    return commitResult.image || commitResult;
  };

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
      const { base64Image, imageUrl, mimeType, userId, toolId } = req.body;

      if (userId && toolId && userId !== 'null' && toolId !== 'null') {
        const verifyRes = await fetch(`${SAAS_ORIGIN}/api/tool/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, toolId })
        });
        const verifyData = await verifyRes.json();
        if (!verifyData.success) {
          return res.status(403).json(verifyData);
        }
      }

      let dataToUse = base64Image;
      let mimeToUse = mimeType;

      if (imageUrl && !base64Image) {
        const imageRes = await fetch(imageUrl);
        const arrayBuffer = await imageRes.arrayBuffer();
        dataToUse = Buffer.from(arrayBuffer).toString('base64');
        mimeToUse = imageRes.headers.get('content-type') || 'image/jpeg';
      }

      const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
      const analysisPromise = ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          { inlineData: { data: dataToUse, mimeType: mimeToUse } },
          { text: "Analyze this restaurant image. Identify the layout, decor style, and specific points that need beautification. CRITICAL RULES for beautification points: 1. Your analysis SHOULD focus on areas like Walls (墙面), Floors (地面), and Tables (桌面). 2. For Tables (桌面), you may suggest staging small functional items like vinegar/salt bottles (醋瓶/盐瓶) or tissue boxes (纸巾盒) to make the space look ready for service. 3. Specifically identify ground trash (地面垃圾), trash cans (垃圾桶), surface clutter (杂物), or people (人物) for removal. 4. These points MUST focus ONLY on cleaning, whitening, refurbishing, and minor staging. 5. DO NOT suggest any structural changes. 6. CRITICAL: NEVER suggest modifying, removing, or changing any text, signs, or menus in the image. 7. Each point MUST be short (under 20 characters). 8. Separately, recommend 3-5 NEW decorative items (soft decor) like plants/art to add ONLY if requested later. Also recommend a lighting effect and explain why. ALL OUTPUT MUST BE IN CHINESE (简体中文). Return JSON." },
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
      return res.status(200).json(JSON.parse(response.text));
    }

    // 3. Beautify Image (AI Generation + SaaS Save)
    if (url.includes('/api/beautify')) {
      const startTime = Date.now();
      const { base64Image, imageUrl, mimeType, analysis, options, allowAdditions, userId, toolId } = req.body;

      // 1. Verify points
      if (userId && toolId && userId !== 'null' && toolId !== 'null') {
        const verifyStart = Date.now();
        const verifyRes = await fetch(`${SAAS_ORIGIN}/api/tool/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, toolId })
        });
        const verifyData = await verifyRes.json();
        console.log(`[Beautify] Verify points took ${Date.now() - verifyStart}ms`);
        if (!verifyData.success) {
          return res.status(403).json(verifyData);
        }
      }

      const getOrigStart = Date.now();
      let dataToUse = base64Image;
      let mimeToUse = mimeType;

      if (imageUrl && !base64Image) {
        const imageRes = await fetch(imageUrl);
        const arrayBuffer = await imageRes.arrayBuffer();
        dataToUse = Buffer.from(arrayBuffer).toString('base64');
        mimeToUse = imageRes.headers.get('content-type') || 'image/jpeg';
        console.log(`[Beautify] Fetch original image took ${Date.now() - getOrigStart}ms`);
      }

      const geminiStart = Date.now();
      const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
      
      const additionsToApply = allowAdditions && analysis.recommendedAdditions
        ? analysis.recommendedAdditions.filter((a: any) => a.enabled).map((a: any) => a.item)
        : [];

      const additionRules = additionsToApply.length > 0
        ? `NEW ADDITIONS (CRITICAL): You MUST add the following items naturally into the scene:\n${additionsToApply.map((item: any, i: number) => `${i + 1}. ${item}`).join('\n')}\nDo not add anything else besides these.`
        : `CRITICAL: DO NOT add any new objects, decorations, plants, art, or furniture. Maintain the original layout and contents EXACTLY. Only perform cleaning and restoration.`;

      const prompt = `You are a professional photo restoration expert. Your task is to refurbish this restaurant image based on the provided analysis: ${analysis.beautifyPoints.join(', ')}.
      CORE REQUIREMENTS:
      1. Execute all cleaning and staging points (e.g., removing trash, whitening walls, adding bottles/tissues to tables).
      2. If '人物', '垃圾', or '垃圾桶' are in the analysis, erase them realistically.
      3. Apply "${options.lighting}" lighting effect.
      4. RESOLUTION & QUALITY: Generate a high quality image with clean details and natural realistic result at ${options.resolution} resolution.
      5. STRICTURE: DO NOT modify, blur, or change any TEXT, SIGNS, or MENUS in the original image. Keep all readable information intact.
      ${additionRules}
      CRITICAL CONSTRAINT: Do NOT change the architectural structure. Maintain the original photo's textual details and brand identity perfectly.`;
      
      const beautifyPromise = ai.models.generateContent({
        model: "gemini-3.1-flash-image-preview",
        contents: {
          parts: [
            { inlineData: { data: dataToUse, mimeType: mimeToUse } },
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

      const response = await withTimeout(beautifyPromise, 300000, "AI 处理超时(300s)");
      console.log(`[Beautify] Gemini generation took ${Date.now() - geminiStart}ms`);

      let generatedImageBase64 = null;
      let generatedMimeType = "image/png";
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          generatedImageBase64 = part.inlineData.data;
          generatedMimeType = part.inlineData.mimeType || "image/png";
          break;
        }
      }

      if (!generatedImageBase64) {
        throw new Error("AI failed to generate image");
      }

      const finalImageBase64 = `data:${generatedMimeType};base64,${generatedImageBase64}`;
      
      console.log(`[Beautify] Total processing time: ${Date.now() - startTime}ms`);
      return res.status(200).json({ 
        success: true, 
        generatedImage: finalImageBase64
      });
    }

    // 4. SaaS Save Result (Async upload after generation)
    if (url.includes('/api/saas/save-result')) {
      const { base64Image, userId, toolId, mimeType } = req.body;
      if (!base64Image || !userId || !toolId) {
        return res.status(400).json({ success: false, error: "Missing required fields for SaaS save" });
      }
      
      let buffer: Buffer;
      let finalMime = mimeType || 'image/png';
      
      if (base64Image.startsWith('data:')) {
        const parts = base64Image.split(',');
        buffer = Buffer.from(parts[1], 'base64');
        const match = parts[0].match(/data:(.*?);/);
        if (match) finalMime = match[1];
      } else {
        buffer = Buffer.from(base64Image, 'base64');
      }

      const saasImage = await saveResultImageToSaas(userId, toolId, buffer, finalMime);
      return res.status(200).json({ success: true, image: saasImage });
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

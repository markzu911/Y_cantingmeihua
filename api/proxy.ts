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

  // Helper to upload image to OSS without committing/consuming
  const uploadToOssOnly = async (userId: string, toolId: string, imageBuffer: Buffer, mimeType: string) => {
    const finalFileName = `beautified-${Date.now()}.jpg`;
    // 1. Get Direct Token
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

    // 2. PUT to OSS
    const uploadRes = await fetch(token.uploadUrl, {
      method: token.method || 'PUT',
      headers: {
        ...(token.headers || {}),
        'Content-Type': mimeType
      },
      body: imageBuffer
    });
    if (!uploadRes.ok) throw new Error(`OSS 上传失败: ${uploadRes.status}`);

    return {
      objectKey: token.objectKey,
      fileSize: imageBuffer.length,
      mimeType,
      fileName: finalFileName
    };
  };

  // Helper to complete the SaaS save (Consume + Commit)
  const commitSaasResult = async (userId: string, toolId: string, pendingUpload: any) => {
    // 1. Consume points
    const consumeRes = await fetch(`${SAAS_ORIGIN}/api/tool/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, toolId })
    });
    const consume = await consumeRes.json();
    if (!consume.success) throw new Error(consume.error || consume.message || '积分扣费失败');

    // 2. Commit
    const commitRes = await fetch(`${SAAS_ORIGIN}/api/upload/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        toolId,
        source: 'result',
        objectKey: pendingUpload.objectKey,
        fileName: pendingUpload.fileName,
        fileSize: pendingUpload.fileSize
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

      const sharpStart = Date.now();
      // Convert generated image to Buffer and process with Sharp
      let imageBuffer = Buffer.from(generatedImageBase64, 'base64');
      try {
        // 恢复最高质量处理：不压缩体积，不缩小尺寸
        imageBuffer = await sharp(imageBuffer)
          .rotate() 
          .jpeg({ 
            quality: 100, 
            chromaSubsampling: '4:4:4',
            force: true 
          })
          .toBuffer();
        
        // Force mime type to jpeg after sharp processing
        generatedMimeType = "image/jpeg";
        console.log(`[Beautify] Sharp processing (HQ) took ${Date.now() - sharpStart}ms`);
      } catch (sharpError) {
        console.error('Sharp processing failed:', sharpError);
      }

      // Upload FULL result to OSS (Stage 1 of save process)
      let pendingUpload = null;
      if (userId && toolId && userId !== 'null' && toolId !== 'null') {
        try {
          const uploadStart = Date.now();
          pendingUpload = await uploadToOssOnly(userId, toolId, imageBuffer, generatedMimeType);
          console.log(`[Beautify] OSS upload took ${Date.now() - uploadStart}ms`);
        } catch (uploadError: any) {
          console.error('[Beautify] Background OSS upload failed:', uploadError.message);
        }
      }

      // Create a small preview for the response to avoid Vercel 4.5MB payload limit
      let previewBase64 = `data:${generatedMimeType};base64,${imageBuffer.toString('base64')}`;
      try {
        const previewBuffer = await sharp(imageBuffer)
          .resize({ width: 1200, withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        previewBase64 = `data:image/jpeg;base64,${previewBuffer.toString('base64')}`;
      } catch (previewError) {
        console.error('Preview generation failed:', previewError);
      }

      console.log(`[Beautify] Total processing time: ${Date.now() - startTime}ms`);
      return res.status(200).json({ 
        success: true, 
        generatedImage: previewBase64,
        pendingUpload
      });
    }

    // 4. Save Result (Stage 2: Consume + Commit)
    if (url.includes('/api/save-result')) {
      const { pendingUpload, userId, toolId } = req.body;
      if (!pendingUpload || !userId || !toolId) {
        return res.status(400).json({ success: false, error: '缺少保存所需的必要元数据' });
      }

      try {
        const saasImage = await commitSaasResult(userId, toolId, pendingUpload);
        return res.status(200).json({ success: true, image: saasImage });
      } catch (saveError: any) {
        console.error('[SaveResult] commit failed:', saveError.message);
        return res.status(500).json({ success: false, error: saveError.message || '图片持久化失败' });
      }
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

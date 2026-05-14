import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenAI, Type } from "@google/genai";

function getGeminiApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key.trim() === "") return "";
  return key.trim().replace(/^["']|["']$/g, '').trim();
}

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
  const saasOrigin = 'http://aibigtree.com';

  // Helper to save result image to SaaS following the standard 3-step flow
  const saveImageToSaas = async (userId: string, toolId: string, base64Data: string, mimeType: string) => {
    const imageBuffer = Buffer.from(base64Data, 'base64');
    
    // 1. Consume
    const consumeRes = await fetch(`${saasOrigin}/api/tool/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, toolId })
    });
    const consume = await consumeRes.json();
    if (!consume.success) throw new Error(consume.message || '积分扣除失败');

    // 2. Direct Token
    const tokenRes = await fetch(`${saasOrigin}/api/upload/direct-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        toolId,
        source: 'result',
        mimeType,
        fileName: 'result.jpg',
        fileSize: imageBuffer.length
      })
    });
    const token = await tokenRes.json();
    if (!token.success) throw new Error(token.error || '获取上传凭证失败');

    // 3. PUT to OSS
    const uploadRes = await fetch(token.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: imageBuffer
    });
    if (!uploadRes.ok) throw new Error('OSS 上传失败');

    // 4. Commit
    const commitRes = await fetch(`${saasOrigin}/api/upload/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        toolId,
        source: 'result',
        objectKey: token.objectKey,
        fileSize: imageBuffer.length
      })
    });
    const commit = await commitRes.json();
    if (!commit.success) throw new Error(commit.error || '上传提交失败');

    return commit.url;
  };

  try {
    // 1. Tool & Upload Proxy
    if (url.includes('/api/tool/') || url.includes('/api/upload/')) {
      const targetUrl = `${saasOrigin}${url}`;
      const response = await fetch(targetUrl, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : JSON.stringify(req.body),
      });
      
      const data = await response.json();
      return res.status(response.status).json(data);
    }

    // 2. Analyze Image
    if (url.includes('/api/analyze')) {
      const { base64Image, mimeType } = req.body;
      const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          { inlineData: { data: base64Image, mimeType: mimeType } },
          { text: "Analyze this restaurant image. Identify the layout, decor style, and specific points that need beautification. CRITICAL RULES for beautification points: 1. You MUST generate specific, descriptive beautification points for at least these three mandatory areas: Walls (墙面), Floors (地面), and Tables (桌面). 2. IN ADDITION to those three, you MUST also add other beautification points based on your visual analysis (e.g., ceiling, windows, specific clutter, etc.). 3. Each point MUST be short (under 20 characters). 4. DO NOT alter, add, or remove existing objects. 5. Recommend 3-5 new decorative items to add (e.g., wall art, plants, tissue boxes). Also recommend a lighting effect from ['暖色调', '清新浅色', '高端暗色'] and explain why. ALL OUTPUT MUST BE IN CHINESE (简体中文). Return the result in JSON format." },
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

    // 3. Beautify Image
    if (url.includes('/api/beautify')) {
      const { base64Image, mimeType, analysis, options, allowAdditions, userId, toolId } = req.body;
      const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
      
      const additionsToApply = allowAdditions && analysis.recommendedAdditions
        ? analysis.recommendedAdditions.filter((a: any) => a.enabled).map((a: any) => a.item)
        : [];

      const additionRules = additionsToApply.length > 0
        ? `NEW ADDITIONS (CRITICAL): You MUST add the following items naturally into the scene:\n${additionsToApply.map((item: any, i: number) => `${i + 1}. ${item}`).join('\n')}\nDo not add anything else besides these.`
        : `CRITICAL: DO NOT add any new objects, decorations, plants, or items that did not exist in the original image.`;

      const prompt = `You are a top-tier professional photo editor and interior designer. Execute EVERY SINGLE initial request for this restaurant.
      TARGET POINTS: ${analysis.beautifyPoints.join(', ')}.
      MANDATORY: Clean floors perfectly, remove table clutter, apply "${options.lighting}" lighting effect.
      ${additionRules}
      CRITICAL: DO NOT change structural layout (windows, doors, walls). HIGHLY REALISTIC finish.`;
      
      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-image-preview",
        contents: {
          parts: [
            { inlineData: { data: base64Image, mimeType: mimeType } },
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

      if (!generatedImageBase64) {
        throw new Error("AI failed to generate image");
      }

      let finalUrl = `data:${generatedMimeType};base64,${generatedImageBase64}`;

      // If SaaS info provided, save and consume
      if (userId && toolId) {
        try {
          const saasUrl = await saveImageToSaas(userId, toolId, generatedImageBase64, generatedMimeType);
          if (saasUrl) finalUrl = saasUrl;
        } catch (saasErr) {
          console.error('SaaS Save failed, falling back to base64:', saasErr);
          // Fallback to base64 is already in finalUrl
        }
      }

      return res.status(200).json({ generatedImage: finalUrl });
    }

    // 4. Generic Gemini fallback
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

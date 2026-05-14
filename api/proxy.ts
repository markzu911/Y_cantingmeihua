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
    if (userId === 'null' || userId === 'undefined' || !userId) throw new Error('Invalid User ID');
    if (toolId === 'null' || toolId === 'undefined' || !toolId) throw new Error('Invalid Tool ID');

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
      
      // Filter out invalid ID strings from body
      const body = { ...req.body };
      if (body.userId === 'null' || body.userId === 'undefined') delete body.userId;
      if (body.toolId === 'null' || body.toolId === 'undefined') delete body.toolId;

      const response = await fetch(targetUrl, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : JSON.stringify(body),
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
      return res.status(200).json(JSON.parse(response.text));
    }

    // 3. Beautify Image (AI Generation ONLY)
    if (url.includes('/api/beautify')) {
      const { base64Image, mimeType, analysis, options, allowAdditions } = req.body;
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
      4. STRICTURE: DO NOT modify, blur, or change any TEXT, SIGNS, or MENUS in the original image. Keep all readable information intact.
      ${additionRules}
      CRITICAL CONSTRAINT: Do NOT change the architectural structure. Maintain the original photo's textual details and brand identity perfectly.`;
      
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

      // Return ONLY base64 immediately to prevent timeout
      return res.status(200).json({ 
        generatedImage: `data:${generatedMimeType};base64,${generatedImageBase64}`,
        rawBase64: generatedImageBase64,
        mimeType: generatedMimeType
      });
    }

    // 3.5 New Endpoint: Save Record (Handle SaaS logic independently)
    if (url.includes('/api/upload-record')) {
      const { userId, toolId, base64Data, mimeType } = req.body;
      if (!userId || !toolId || !base64Data) {
        return res.status(400).json({ error: 'Missing parameters' });
      }
      
      const saasUrl = await saveImageToSaas(userId, toolId, base64Data, mimeType || "image/png");
      return res.status(200).json({ success: true, url: saasUrl });
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

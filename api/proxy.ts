import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenAI, Type } from "@google/genai";
import sharp from 'sharp';

function getGeminiApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key.trim() === "") return "";
  return key.trim().replace(/^["']|["']$/g, '').trim();
}

const SAAS_ORIGIN = 'http://aibigtree.com';

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

/**
 * Standard 3-step SaaS Image Save Flow (Consume -> Token -> PUT -> Commit)
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
  const uid = filterIds(userId);
  const tid = filterIds(toolId);
  if (!uid || !tid) throw new Error('Invalid UserID or ToolID for SaaS save');

  // 1. Consume
  const consumeRes = await fetch(`${SAAS_ORIGIN}/api/tool/consume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: uid, toolId: tid })
  });
  await readJsonResponse(consumeRes); // Just check if successful

  // 2. Direct Token
  const tokenRes = await fetch(`${SAAS_ORIGIN}/api/upload/direct-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: uid,
      toolId: tid,
      source: 'result',
      mimeType,
      fileName,
      fileSize: imageBuffer.length
    })
  });
  const token = await readJsonResponse(tokenRes);

  // 3. PUT to OSS
  const uploadRes = await fetch(token.uploadUrl, {
    method: token.method || 'PUT',
    headers: { ...token.headers, 'Content-Type': mimeType },
    body: imageBuffer
  });
  if (!uploadRes.ok) throw new Error(`OSS Upload failed: ${uploadRes.status}`);

  // 4. Commit
  const commitRes = await fetch(`${SAAS_ORIGIN}/api/upload/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: uid,
      toolId: tid,
      source: 'result',
      objectKey: token.objectKey,
      fileSize: imageBuffer.length
    })
  });
  const commit = await readJsonResponse(commitRes);
  
  return commit.image || commit;
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

const handler = async (req: VercelRequest, res: VercelResponse) => {
  const url = req.url || '';

  try {
    // 1. Tool & Upload Proxy
    if (url.includes('/api/tool/') || url.includes('/api/upload/')) {
      const targetUrl = `${SAAS_ORIGIN}${url}`;
      
      const body = { ...req.body };
      if (body.userId) body.userId = filterIds(body.userId);
      if (body.toolId) body.toolId = filterIds(body.toolId);

      const response = await fetch(targetUrl, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : JSON.stringify(body),
      });
      
      const data = await readJsonResponse(response);
      return res.status(200).json(data);
    }

    // 2. Analyze Image
    if (url.includes('/api/analyze')) {
      const { base64Image, mimeType } = req.body;
      
      // Normalize input image (Section 6)
      const inputBuffer = Buffer.from(base64Image, 'base64');
      const normalizedBuffer = await normalizeInputImage(inputBuffer);
      const normalizedBase64 = normalizedBuffer.toString('base64');

      const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          { inlineData: { data: normalizedBase64, mimeType: "image/jpeg" } },
          { text: "Analyze this restaurant image. Identify the layout, decor style, and specific points that need beautification. CRITICAL RULES for beautification points: 1. Your analysis SHOULD focus on areas like Walls (墙面), Floors (地面), and Tables (桌面). 2. For Tables (桌面), you may suggest staging small functional items like vinegar/salt bottles (醋瓶/盐瓶) or tissue boxes (纸巾盒) to make the space look ready for service. 3. Specifically identify ground trash (地面垃圾), trash cans (垃圾桶), surface clutter (杂物), or people (人物) for removal. 4. These points MUST focus ONLY on cleaning, whitening, refurbishing, and minor staging. 5. DO NOT suggest any structural changes. 6. CRITICAL: NEVER suggest modifying, removing, or changing any text, signs, or menus in the image. 7. NOT ADDING EXTRA TEXT: If there is no text in the image, do not suggest adding any. 8. Each point MUST be short (under 20 characters). 9. Separately, recommend 3-5 NEW decorative items (soft decor) like plants/art to add ONLY if requested later. Also recommend a lighting effect and explain why. ALL OUTPUT MUST BE IN CHINESE (简体中文). Return JSON." },
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
        : `CRITICAL: DO NOT add any new objects, decorations, plants, art, or furniture. Maintain the original layout and contents EXACTLY. Only perform cleaning and restoration.`;

      const prompt = `You are a professional photo restoration expert. Your task is to refurbish this restaurant image based on the provided analysis: ${analysis.beautifyPoints.join(', ')}.
      CORE REQUIREMENTS:
      1. Execute all cleaning and staging points (e.g., removing trash, whitening walls, adding bottles/tissues to tables).
      2. If '人物', '垃圾', or '垃圾桶' are in the analysis, erase them realistically.
      3. Apply "${options.lighting}" lighting effect.
      4. STRICTEST RULE: DO NOT modify, blur, change, or remove any existing TEXT, SIGNS, or MENUS. DO NOT add any new text or characters that were not in the original photo. Keep all readable information exactly as it is.
      ${additionRules}
      CRITICAL CONSTRAINT: Do NOT change the architectural structure. Maintain the original photo's textual details and brand identity perfectly. The result must be a clean, professional version of the original photo.`;
      
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

      if (!generatedImageBase64) {
        throw new Error("AI failed to generate image");
      }

      const uid = filterIds(userId);
      const tid = filterIds(toolId);
      let finalData = { 
        generatedImage: `data:${generatedMimeType};base64,${generatedImageBase64}`,
        rawBase64: generatedImageBase64,
        mimeType: generatedMimeType
      };

      // SaaS Save Logic (Synchronous as per section 8 & 9)
      if (uid && tid) {
        try {
          const resultBuffer = Buffer.from(generatedImageBase64, 'base64');
          const saasImage = await saveResultImageToSaas({
            userId: uid,
            toolId: tid,
            imageBuffer: resultBuffer,
            mimeType: generatedMimeType,
            fileName: `restaurant_${Date.now()}.png`
          });
          
          finalData = {
            ...finalData,
            ...saasImage,
            generatedImage: saasImage.url || finalData.generatedImage
          };
        } catch (saasErr: any) {
          console.error('SaaS Save Error:', saasErr.message);
        }
      }

      return res.status(200).json(finalData);
    }

    // 3.5 New Endpoint: Save Record (Handle SaaS logic independently)
    if (url.includes('/api/upload-record')) {
      const { userId, toolId, base64Data, mimeType } = req.body;
      const uid = filterIds(userId);
      const tid = filterIds(toolId);
      if (!uid || !tid || !base64Data) {
        return res.status(400).json({ error: 'Missing parameters or invalid IDs' });
      }
      
      const imageBuffer = Buffer.from(base64Data, 'base64');
      const saasImage = await saveResultImageToSaas({
        userId: uid,
        toolId: tid,
        imageBuffer,
        mimeType: mimeType || "image/png"
      });
      return res.status(200).json({ success: true, ...saasImage });
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

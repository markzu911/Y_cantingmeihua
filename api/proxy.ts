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
  try {
    // 1. Tool Proxy & Upload Proxy
    if (url.includes('/api/tool/') || url.includes('/api/upload/direct-token') || url.includes('/api/upload/commit')) {
      const targetPath = url.includes('?') ? url : url; 
      const targetUrl = `http://aibigtree.com${targetPath}`;
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
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
      const { base64Image, mimeType, analysis, options, allowAdditions } = req.body;
      const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
      
      const additionsToApply = allowAdditions && analysis.recommendedAdditions
        ? analysis.recommendedAdditions.filter((a: any) => a.enabled).map((a: any) => a.item)
        : [];

      const additionRules = additionsToApply.length > 0
        ? `NEW ADDITIONS (CRITICAL): You MUST add the following items naturally into the scene:\n${additionsToApply.map((item: any, i: number) => `${i + 1}. ${item}`).join('\n')}\nDo not add anything else besides these.`
        : `CRITICAL: DO NOT add any new objects, decorations, plants, or items that did not exist in the original image.`;

      const prompt = `You are a top-tier professional photo editor and interior designer. Your task is to renovate and beautify this restaurant image.

CRITICAL STRUCTURAL RULES (NEVER VIOLATE):
1. Keep the original spatial structure, doors, windows, walls, table and chair positions, and main layout EXACTLY the same.
2. DO NOT add new doors or windows, DO NOT change the architectural structure, and DO NOT significantly change the number or position of tables and chairs.
3. This is STRICTLY for cleaning, beautifying, material restoring, lighting, and soft furnishing.

MANDATORY BASELINE & BEAUTIFICATION POINTS:
1. FLOOR: Must be completely clean, intact, and have premium texture. Remove all dirt, stains, damages, and dark spots.
2. WALLS: Can be restored, brightened, and color-unified, but DO NOT change the wall structure.
3. TABLES: Remove all clutter, keep reasonable restaurant items (tissue boxes, condiments) and organize them neatly.
4. ATMOSPHERE: Apply a "${options.lighting}" lighting effect.
5. USER'S SPECIFIC POINTS:
${analysis.beautifyPoints.map((p: string, i: number) => `   - ${p}`).join('\n')}

DECORATION RULES:
${allowAdditions && additionsToApply.length > 0
  ? `The user ENABLED decorations. You MUST add ONLY the following checked items: \n${additionsToApply.join(', ')}. DO NOT add any other extra items (no extra plants, no extra lamps, no extra ornaments).`
  : `The user DISABLED decorations. DO NOT add ANY new decorations, new plants, new lamps, or new ornaments. Keep it purely renovation.`}

STYLE RULES:
- Output must be highly realistic and natural, like a professional interior photography.
- NO cartoon style, NO over-rendering, NO text, NO watermarks, NO logos, and NO explanatory text.`;
      
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

      let generatedImage = null;
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          generatedImage = `data:${part.inlineData.mimeType || "image/png"};base64,${part.inlineData.data}`;
          break;
        }
      }
      return res.status(200).json({ generatedImage });
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

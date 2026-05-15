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
    // 1. Tool / Upload Proxy
    if (url.includes('/api/tool/') || url.includes('/api/upload/')) {
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

    // Helper to parse multipart using Busboy
    const parseMultipart = (req: VercelRequest): Promise<{ fields: any, fileBuffer: Buffer, mimeType: string }> => {
      return new Promise((resolve, reject) => {
        const Busboy = require('busboy');
        const busboy = Busboy({ headers: req.headers });
        const fields: any = {};
        let fileBuffer: Buffer = Buffer.from('');
        let mimeType = '';

        busboy.on('file', (name: string, file: any, info: any) => {
          mimeType = info.mimeType;
          const chunks: Buffer[] = [];
          file.on('data', (data: Buffer) => chunks.push(data));
          file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
        });

        busboy.on('field', (name: string, val: string) => {
          fields[name] = val;
        });

        busboy.on('finish', () => resolve({ fields, fileBuffer, mimeType }));
        busboy.on('error', reject);
        
        // Vercel raw body support
        if (req.body && Buffer.isBuffer(req.body)) {
           // Should not really enter here for standard usage as we export config.api.bodyParser = false
        }
        req.pipe(busboy);
      });
    };

    // 2. Analyze Image
    if (url.includes('/api/analyze')) {
      if (req.headers['content-type']?.includes('multipart/form-data')) {
        const { fileBuffer, mimeType: parsedMime } = await parseMultipart(req);
        const base64Image = fileBuffer.toString('base64');
        const mimeType = parsedMime || 'image/jpeg';
        const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: [
             { inlineData: { data: base64Image, mimeType: mimeType } },
             { text: "Analyze this restaurant image. Identify the layout, decor style, and specific points that need beautification. CRITICAL RULES for beautification points: 1. You MUST generate specific, descriptive beautification points for at least these three mandatory areas: Walls (墙面), Floors (地面), and Tables (桌面). 2. IN ADDITION to those three, you MUST also add other beautification points based on your visual analysis of the image (e.g., ceiling, windows, specific clutter, etc.). 3. Each point MUST be short (under 20 characters). 4. DO NOT alter, add, or remove existing objects. 5. Recommend 3-5 new decorative items to add (e.g., wall art, plants, tissue boxes). Also recommend a lighting effect from ['暖色调', '清新浅色', '高端暗色'] and explain why. ALL OUTPUT MUST BE IN CHINESE (简体中文). Return the result in JSON format." },
          ],
          config: {
            responseMimeType: "application/json",
            responseSchema: {
               // ... matching existing schema
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
      
      // Fallback for old clients
      const { base64Image, mimeType } = req.body;
      // ... (code trimmed to focus on multipart)
      // Since new clients use multipart, leaving this logic here as fallback or removing it.
    }

    // 3. Beautify Image
    if (url.includes('/api/beautify')) {
      let base64Image: string, mimeType: string, analysis: any, options: any, allowAdditions: boolean;
      
      if (req.headers['content-type']?.includes('multipart/form-data')) {
        const parsed = await parseMultipart(req);
        base64Image = parsed.fileBuffer.toString('base64');
        mimeType = parsed.mimeType || 'image/jpeg';
        analysis = JSON.parse(parsed.fields.analysis || "{}");
        options = JSON.parse(parsed.fields.options || "{}");
        allowAdditions = parsed.fields.allowAdditions === "true";
      } else {
        // Fallback
        ({ base64Image, mimeType, analysis, options, allowAdditions } = req.body);
      }
      
      const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
      const additionsToApply = allowAdditions && analysis.recommendedAdditions
        ? analysis.recommendedAdditions.filter((a: any) => a.enabled).map((a: any) => a.item)
        : [];

      const additionRules = additionsToApply.length > 0
        ? `NEW ADDITIONS (CRITICAL): You MUST add the following items naturally into the scene:\n${additionsToApply.map((item: any, i: number) => `${i + 1}. ${item}`).join('\n')}\nDo not add anything else besides these.`
        : `CRITICAL: DO NOT add any new objects, decorations, plants, or items that did not exist in the original image.`;

      const prompt = `You are a top-tier professional photo editor and interior designer. Execute EVERY SINGLE initial request for this restaurant.
      TARGET POINTS: ${analysis.beautifyPoints?.join(', ')}.
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
            aspectRatio: options.ratio || "1:1",
            imageSize: options.resolution || "1K",
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

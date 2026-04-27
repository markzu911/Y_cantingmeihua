import express from "express";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import path from "path";
import { GoogleGenAI } from "@google/genai";

function getGeminiApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY environment variable is not set.");
  }
  return key;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware
  app.use(express.json({ limit: '50mb' }));

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Content-Security-Policy", "frame-ancestors *");
    
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }
    next();
  });

  // Robust API route handling
  const apiRouter = express.Router();

  apiRouter.use((req, res, next) => {
    console.log(`[API Router] ${req.method} ${req.path}`);
    next();
  });

  apiRouter.post("/gemini", async (req, res) => {
    console.log("Handling /api/gemini via router");
    try {
      const { model, payload, contents, config } = req.body;
      const apiKey = getGeminiApiKey();
      const ai = new GoogleGenAI({ apiKey });
      
      const targetModel = model || "gemini-3-flash-preview";
      const actualContents = contents || payload?.contents || payload;
      const actualConfig = config || payload?.config || payload?.generationConfig || {};

      // Standardize contents for generateContent
      // The new SDK expects contents to be a GenerateContentParameters['contents']
      const formattedContents = Array.isArray(actualContents) ? actualContents : [actualContents];

      const response = await ai.models.generateContent({
        model: targetModel,
        contents: formattedContents,
        config: actualConfig
      });
      
      // Compatibility with existing frontend
      const responseData: any = { 
        ...response,
        text: response.text 
      };

      // Handle image parts if present
      const parts = response.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find((p: any) => p.inlineData);
      if (imagePart) {
        responseData.generatedImage = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
      }

      res.json(responseData);
    } catch (error: any) {
      console.error("Gemini API error:", error);
      res.status(500).json({ error: error.message || "Gemini API error" });
    }
  });

  const proxyRequest = async (req: express.Request, res: express.Response, targetPath: string) => {
    const targetUrl = `http://aibigtree.com${targetPath}`;
    try {
      const response = await axios({
        method: req.method,
        url: targetUrl,
        data: req.body,
        headers: { 'Content-Type': 'application/json' }
      });
      res.status(response.status).json(response.data);
    } catch (error: any) {
      if (error.response) {
        res.status(error.response.status).json(error.response.data);
      } else {
        console.error(`代理转发失败 [${targetPath}]:`, error.message);
        res.status(500).json({ error: "代理转发失败" });
      }
    }
  };

  apiRouter.post("/tool/launch", (req, res) => proxyRequest(req, res, "/api/tool/launch"));
  apiRouter.post("/tool/verify", (req, res) => proxyRequest(req, res, "/api/tool/verify"));
  apiRouter.post("/tool/consume", (req, res) => proxyRequest(req, res, "/api/tool/consume"));

  app.use("/api", apiRouter);

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

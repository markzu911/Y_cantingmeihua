import express from "express";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import axios from "axios";
import { GoogleGenAI } from "@google/genai";

dotenv.config({ override: true });

function getGeminiApiKey() {
  const key = process.env.GEMINI_API_KEY?.trim().replace(/^["']|["']$/g, '');
  if (!key || key === "MY_GEMINI_API_KEY" || key === "") {
    throw new Error("GEMINI_API_KEY is not set or is still the placeholder. Please set a valid API key in the environmental variables.");
  }
  return key;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Increase the payload size limit for base64 images
  app.use(express.json({ limit: '50mb' }));

  // SaaS Proxy logic
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
      console.error(`Proxy error for ${targetPath}:`, error.message);
      res.status(500).json({ success: false, error: "代理转发失败" });
    }
  };

  app.post("/api/tool/launch", (req, res) => proxyRequest(req, res, "/api/tool/launch"));
  app.post("/api/tool/verify", (req, res) => proxyRequest(req, res, "/api/tool/verify"));
  app.post("/api/tool/consume", (req, res) => proxyRequest(req, res, "/api/tool/consume"));

  app.post("/api/gemini", async (req, res) => {
    try {
      const { model, contents, config } = req.body;
      const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
      
      const requestArgs: any = {
        model,
        contents,
      };
      
      if (config) {
        requestArgs.config = config;
      }

      const response = await ai.models.generateContent(requestArgs);
      
      let text = null;
      try {
        text = response.text;
      } catch(e) {}
      
      let inlineData = null;
      let parts = response.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData) {
          inlineData = part.inlineData;
          break;
        }
      }
      
      res.json({ text, inlineData });
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    // Support Express v4 default setup
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

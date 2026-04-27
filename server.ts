import express from "express";
import path from "path";
import fs from "fs";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import axios from "axios";

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

  // Debug middleware to log all requests
  app.use((req, res, next) => {
    console.log(`[REQ] ${req.method} ${req.url}`);
    next();
  });

  // Handle potential SaaS proxy path prefix /ai-tool/:toolId/api/...
  app.use((req, res, next) => {
    if (req.url.startsWith('/ai-tool/')) {
      const originalUrl = req.url;
      const parts = req.url.split('/');
      // Expected: /ai-tool/eb34.../api/analyze -> parts: ["", "ai-tool", "eb34...", "api", "analyze"]
      if (parts.length >= 4) {
        req.url = '/' + parts.slice(3).join('/');
        console.log(`[REWRITE] ${originalUrl} -> ${req.url}`);
      }
    }
    next();
  });

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

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

  // Generic Gemini API endpoint for frontend bridge
  app.post("/api/gemini", async (req, res) => {
    try {
      const { model, payload } = req.body;
      if (!model) {
        return res.status(400).json({ error: "Missing model" });
      }
      if (!payload) {
        return res.status(400).json({ error: "Missing payload" });
      }

      const ai = new GoogleGenAI({ apiKey: getGeminiApiKey() });
      
      // The new SDK @google/genai uses ai.models.generateContent
      const response = await ai.models.generateContent({
        model: model,
        ...payload
      });
      
      res.json({ 
        text: response.text || "",
        // Include full response just in case the frontend needs it
        raw: response
      });
    } catch (error: any) {
      console.error("Gemini bridge error:", error);
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

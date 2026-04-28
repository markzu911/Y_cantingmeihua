import { GoogleGenAI, Type } from "@google/genai";

export interface AnalysisResult {
  layout: string;
  style: string;
  beautifyPoints: string[];
  recommendedLighting: string;
  lightingReason: string;
  recommendedAdditions: { item: string; reason: string; enabled: boolean }[];
}

function getGeminiApiKey() {
  // @ts-ignore
  const key = process.env.GEMINI_API_KEY?.trim().replace(/^["']|["']$/g, '');
  if (!key || key === "MY_GEMINI_API_KEY" || key === "") {
    throw new Error("GEMINI_API_KEY is not set. Please set a valid API key in the environmental variables.");
  }
  return key;
}

export async function analyzeRestaurantImage(base64Image: string, mimeType: string): Promise<AnalysisResult> {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ base64Image, mimeType }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "Failed to analyze image");
  }

  const result = await response.json();
  
  // 初始化推荐物品的启用状态
  if (result.recommendedAdditions) {
    result.recommendedAdditions = result.recommendedAdditions.map((a: any) => ({ ...a, enabled: true }));
  } else {
    result.recommendedAdditions = [];
  }
  
  return result;
}

export async function beautifyRestaurantImage(
  base64Image: string,
  mimeType: string,
  analysis: AnalysisResult,
  options: { ratio: string; lighting: string; resolution: string },
  allowAdditions: boolean
): Promise<string> {
  const response = await fetch("/api/beautify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      base64Image,
      mimeType,
      analysis,
      options,
      allowAdditions,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "Failed to beautify image");
  }

  const data = await response.json();
  return data.generatedImage;
}


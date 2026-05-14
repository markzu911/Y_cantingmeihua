import { Type } from "@google/genai";

export interface AnalysisResult {
  layout: string;
  style: string;
  beautifyPoints: string[];
  recommendedLighting: string;
  lightingReason: string;
  recommendedAdditions: { item: string; reason: string; enabled: boolean }[];
}

export async function analyzeRestaurantImage(
  base64Image: string,
  mimeType: string,
  userId?: string | null,
  toolId?: string | null
): Promise<AnalysisResult> {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ base64Image, mimeType, userId, toolId }),
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

export interface SaasImage {
  recordId: string;
  url: string;
  fileName: string;
  fileSize?: number;
}

export async function beautifyRestaurantImage(
  base64Image: string,
  mimeType: string,
  analysis: AnalysisResult,
  options: { ratio: string; lighting: string; resolution: string },
  allowAdditions: boolean,
  userId?: string | null,
  toolId?: string | null
): Promise<{ success: boolean; generatedImage: string; image?: SaasImage }> {
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
      userId,
      toolId
    }),
  });

  const result = await response.json().catch(() => ({ success: false, error: "Network error" }));

  if (!response.ok || result.success === false) {
    throw new Error(result.error || "Failed to beautify image");
  }

  return result;
}

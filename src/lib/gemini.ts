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
  base64Image: string | null,
  mimeType: string | null,
  userId?: string | null,
  toolId?: string | null,
  imageUrl?: string | null,
  file?: File | null
): Promise<AnalysisResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000); // 300s timeout

  try {
    let response;
    
    if (file) {
      const formData = new FormData();
      formData.append('image', file);
      if (userId) formData.append('userId', userId);
      if (toolId) formData.append('toolId', toolId);
      if (imageUrl) formData.append('imageUrl', imageUrl);
      
      response = await fetch("/api/analyze", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
    } else {
      response = await fetch("/api/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ base64Image, imageUrl, mimeType, userId, toolId }),
        signal: controller.signal,
      });
    }

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
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface SaasImage {
  recordId: string;
  url: string;
  fileName: string;
  fileSize?: number;
}

export async function beautifyRestaurantImage(
  base64Image: string | null,
  mimeType: string | null,
  analysis: AnalysisResult,
  options: { ratio: string; lighting: string; resolution: string },
  allowAdditions: boolean,
  userId?: string | null,
  toolId?: string | null,
  imageUrl?: string | null,
  file?: File | null
): Promise<{ success: boolean; generatedImage: string; image?: SaasImage }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000); // 300s timeout

  try {
    let response;
    
    if (file) {
      const formData = new FormData();
      formData.append('image', file);
      formData.append('analysis', JSON.stringify(analysis));
      formData.append('options', JSON.stringify(options));
      formData.append('allowAdditions', String(allowAdditions));
      if (userId) formData.append('userId', userId);
      if (toolId) formData.append('toolId', toolId);
      if (imageUrl) formData.append('imageUrl', imageUrl);
      
      response = await fetch("/api/beautify", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
    } else {
      response = await fetch("/api/beautify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          base64Image,
          imageUrl,
          mimeType,
          analysis,
          options,
          allowAdditions,
          userId,
          toolId
        }),
        signal: controller.signal,
      });
    }

    const result = await response.json().catch(() => ({ success: false, error: "Network error or timeout" }));

    if (!response.ok || result.success === false) {
      throw new Error(result.error || "Failed to beautify image");
    }

    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

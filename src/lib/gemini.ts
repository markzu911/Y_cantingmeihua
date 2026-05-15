import { Type } from "@google/genai";

export interface AnalysisResult {
  layout: string;
  style: string;
  beautifyPoints: string[];
  recommendedLighting: string;
  lightingReason: string;
  recommendedAdditions: { item: string; reason: string; enabled: boolean }[];
}

export async function analyzeRestaurantImage(file: File): Promise<AnalysisResult> {
  const formData = new FormData();
  formData.append("image", file);
  formData.append("mimeType", file.type);

  const response = await fetch("/api/analyze", {
    method: "POST",
    body: formData,
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
  file: File,
  analysis: AnalysisResult,
  options: { ratio: string; lighting: string; resolution: string },
  allowAdditions: boolean
): Promise<string> {
  const formData = new FormData();
  formData.append("image", file);
  formData.append("mimeType", file.type);
  formData.append("analysis", JSON.stringify(analysis));
  formData.append("options", JSON.stringify(options));
  formData.append("allowAdditions", String(allowAdditions));

  const response = await fetch("/api/beautify", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "Failed to beautify image");
  }

  const data = await response.json();
  return data.generatedImage;
}

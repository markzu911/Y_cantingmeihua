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
  imageUrl?: string | null
): Promise<AnalysisResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000); // 300s timeout

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ base64Image, imageUrl, mimeType, userId, toolId }),
      signal: controller.signal,
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
  imageUrl?: string | null
): Promise<{ success: boolean; generatedImage: string; image?: SaasImage }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000); // 300s timeout

  try {
    const startResponse = await fetch("/api/beautify/start", {
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

    const startResult = await startResponse.json().catch(() => ({ success: false, error: "Network error starting job" }));

    if (!startResponse.ok || startResult.success === false) {
      throw new Error(startResult.error || "Failed to start beautify job");
    }

    const { jobId } = startResult;

    // Polling loop
    while (true) {
      if (controller.signal.aborted) {
        throw new Error("Job timed out");
      }
      
      await new Promise(r => setTimeout(r, 2000)); // Poll every 2 seconds

      const statusRes = await fetch(`/api/beautify/status/${jobId}`, {
        signal: controller.signal
      });

      if (!statusRes.ok) {
        continue; // possibly temporary network error, keep trying
      }

      const statusResult = await statusRes.json();

      if (statusResult.status === "completed") {
        return { success: true, generatedImage: statusResult.generatedImage };
      }
      if (statusResult.status === "failed") {
        throw new Error(statusResult.error || "Generation failed in background");
      }
      // if processing, continue loop
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

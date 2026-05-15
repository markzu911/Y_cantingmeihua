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

export interface BeautifyTaskResult {
  success: boolean;
  status: 'processing' | 'completed' | 'failed';
  progress: number;
  message?: string;
  image?: SaasImage;
  error?: string;
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
  onProgress?: (progress: number, message: string) => void
): Promise<{ success: boolean; image?: SaasImage }> {
  try {
    // 1. Create Task
    const startResponse = await fetch("/api/beautify-task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    });

    const startResult = await startResponse.json();
    if (!startResponse.ok || !startResult.success) {
      throw new Error(startResult.error || "Failed to start beautify task");
    }

    const { taskId } = startResult;

    // 2. Poll for Status
    let attempts = 0;
    while (attempts < 100) { // Max 100 attempts (approx 5 mins if 3s delay)
      attempts++;
      const statusResponse = await fetch(`/api/task-status?taskId=${taskId}`);
      const statusResult: BeautifyTaskResult = await statusResponse.json();

      if (!statusResponse.ok || !statusResult.success) {
        throw new Error(statusResult.error || "Failed to check task status");
      }

      if (statusResult.status === 'completed') {
        if (onProgress) onProgress(100, "完成");
        return { success: true, image: statusResult.image };
      }

      if (statusResult.status === 'failed') {
        throw new Error(statusResult.error || "Task failed");
      }

      if (statusResult.status === 'processing') {
        if (onProgress) onProgress(statusResult.progress, statusResult.message || "进行中...");
      }

      // Wait 3 seconds before next poll
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    throw new Error("Task timed out");
  } catch (error: any) {
    console.error("Beautify error:", error);
    throw error;
  }
}

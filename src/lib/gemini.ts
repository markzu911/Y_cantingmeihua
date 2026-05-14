import { Type } from "@google/genai";

export interface AnalysisResult {
  layout: string;
  style: string;
  beautifyPoints: string[];
  recommendedLighting: string;
  lightingReason: string;
  recommendedAdditions: { item: string; reason: string; enabled: boolean }[];
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
  allowAdditions: boolean,
  userId?: string | null,
  toolId?: string | null
): Promise<{ generatedImage: string; rawBase64: string; mimeType: string }> {
  // 1. Initial Request to get Task ID
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

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "Failed to initiate beautification task");
  }

  const { taskId } = await response.json();
  if (!taskId) throw new Error("No taskId returned from server");

  // 2. Poll for Task Completion
  const maxAttempts = 60; // 60 * 3s = 180s timeout
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 3000)); // Poll every 3 seconds

    const pollRes = await fetch(`/api/tasks/${taskId}`);
    if (!pollRes.ok) continue;

    const task = await pollRes.json();
    if (task.status === 'completed') {
      return task.data;
    }
    if (task.status === 'failed') {
      throw new Error(task.error || "Generation task failed");
    }
    // Stay in loop if 'pending' or 'processing'
  }

  throw new Error("Task timed out. AI generation is taking longer than expected.");
}

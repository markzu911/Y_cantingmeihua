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
  const response = await fetch("/app-api/analyze", {
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
  // 1. Initial Request (Task Start)
  const response = await fetch("/app-api/beautify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    throw new Error(err.error || "Failed to start beautification task");
  }

  const { taskId } = await response.json();
  if (!taskId) throw new Error("Server failed to provide a Task ID");

  // 2. Polling Logic
  const maxAttempts = 60; // 60 * 2s = 120s max
  let attempts = 0;

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s between polls
    attempts++;

    const statusRes = await fetch(`/app-api/task-status?taskId=${taskId}`);
    if (!statusRes.ok) continue; // Try again on temporary network issues

    const task = await statusRes.json();
    
    if (task.status === 'success') {
      return task.result;
    }
    
    if (task.status === 'error') {
      throw new Error(task.error || "AI Generation Task Failed");
    }

    // Continue polling if status is 'processing'
  }

  throw new Error("Task timed out. The generation is taking too long.");
}

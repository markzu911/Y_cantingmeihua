import { Type } from "@google/genai";

export interface AnalysisResult {
  layout: string;
  style: string;
  beautifyPoints: string[];
  recommendedLighting: string;
  lightingReason: string;
  recommendedAdditions: { item: string; reason: string; enabled: boolean }[];
}

export interface SaasImage {
  recordId: string;
  url: string;
  fileName: string;
  fileSize?: number;
}

export interface TaskStatus {
  success: boolean;
  status: 'processing' | 'completed' | 'failed';
  progress: number;
  message?: string;
  result?: SaasImage;
  error?: string;
}

export async function analyzeRestaurantImage(
  imageFile: File,
  userId?: string | null,
  toolId?: string | null
): Promise<AnalysisResult> {
  const formData = new FormData();
  formData.append('image', imageFile);
  formData.append('paramsJSON', JSON.stringify({ userId, toolId }));

  const response = await fetch("/api/analyze", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "分析失败");
  }

  const result = await response.json();
  if (result.recommendedAdditions) {
    result.recommendedAdditions = result.recommendedAdditions.map((a: any) => ({ ...a, enabled: true }));
  } else {
    result.recommendedAdditions = [];
  }
  return result;
}

export async function createBeautifyTask(
  imageFile: File,
  analysis: AnalysisResult,
  options: { ratio: string; lighting: string; resolution: string },
  allowAdditions: boolean,
  userId?: string | null,
  toolId?: string | null
): Promise<{ success: boolean; taskId: string }> {
  const formData = new FormData();
  formData.append('image', imageFile);
  formData.append('paramsJSON', JSON.stringify({
    userId, toolId, analysis, options, allowAdditions
  }));

  const response = await fetch("/api/beautify-task", {
    method: "POST",
    body: formData,
  });

  const result = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || "创建任务失败");
  }

  return result;
}

export async function getTaskStatus(taskId: string): Promise<TaskStatus> {
  const response = await fetch(`/api/task-status?taskId=${taskId}`);
  return await response.json();
}

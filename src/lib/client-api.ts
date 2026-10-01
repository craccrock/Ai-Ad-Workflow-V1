"use client";

import type { GenerationWithUser, Media } from "@/lib/types";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.json !== undefined ? { "content-type": "application/json" } : {}), ...init?.headers },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const details = Array.isArray(body.details) ? body.details.map((d: unknown) => (typeof d === "string" ? d : (d as { message?: string }).message)).join(" ") : "";
    throw new ApiError([body.error, details].filter(Boolean).join(" — ") || `Request failed (${res.status})`, res.status, body.details);
  }
  return body as T;
}

/** API returns serialized generations; the UI works with the same shape. */
export type ApiGeneration = Pick<
  GenerationWithUser,
  | "id"
  | "batch_id"
  | "status"
  | "model"
  | "model_display_name"
  | "provider"
  | "media_type"
  | "prompt"
  | "params"
  | "result_url"
  | "cost_usd"
  | "estimated_cost_usd"
  | "duration_seconds"
  | "resolution"
  | "aspect_ratio"
  | "is_shared"
  | "source"
  | "fallback_reason"
  | "user_id"
  | "result_metadata"
  | "created_at"
  | "completed_at"
> & { error: string | null; user?: GenerationWithUser["user"] };

export type ApiMedia = Media & { user?: GenerationWithUser["user"] };

export type Paginated<T> = { data: T[]; page: number; limit: number; total: number; has_more: boolean };

/** Force a download of a cross-origin file (the `download` attribute is ignored cross-origin). */
export async function downloadFile(url: string, filename: string) {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

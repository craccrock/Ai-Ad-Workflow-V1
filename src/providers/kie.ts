import "server-only";
import { KIE_USD_PER_CREDIT, type ModelConfig } from "@/config/models.config";
import { env } from "@/lib/env";
import { errorMessage } from "@/lib/utils";
import type { ProviderAdapter, ProviderFile, ProviderState } from "./types";

/**
 * Kie.ai jobs API (docs.kie.ai/market/quickstart).
 *   POST /api/v1/jobs/createTask { model, input, callBackUrl } → { data: { taskId } }
 *   GET  /api/v1/jobs/recordInfo?taskId=…  → state: waiting | queuing | generating | success | fail
 * Every response wraps the payload as { code, msg, data }; `code` 200 means success.
 */

const BASE_URL = "https://api.kie.ai";

type KieEnvelope<T> = { code: number; msg: string; data: T };

type KieTaskRecord = {
  taskId: string;
  model: string;
  state: "waiting" | "queuing" | "generating" | "success" | "fail";
  resultJson?: string | null;
  failCode?: string | null;
  failMsg?: string | null;
  costTime?: number;
  creditsConsumed?: number;
  createTime?: number;
  completeTime?: number;
};

export class KieError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

async function kie<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.kieApiKey}`, "Content-Type": "application/json", ...init?.headers },
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => null)) as KieEnvelope<T> | null;
  const code = body?.code ?? res.status;
  if (!res.ok || code !== 200) throw new KieError(code, `Kie ${code}: ${body?.msg || res.statusText || "request failed"}`);
  return body!.data;
}

/**
 * Market "tasks" that Kie answers inline instead of queueing (e.g. Suno's timestamped lyrics, 2026-09-25):
 * createTask returns the result itself under `data`.
 */
export async function kieInlineTask<T>(model: string, input: Record<string, unknown>): Promise<T> {
  const data = await kie<{ code?: number; msg?: string; data?: T } & Partial<T>>("/api/v1/jobs/createTask", {
    method: "POST",
    body: JSON.stringify({ model, input }),
  });
  if (data && typeof data === "object" && "data" in data) {
    if (data.code != null && data.code !== 200) throw new KieError(data.code, `Kie ${data.code}: ${data.msg || "request failed"}`);
    return data.data as T;
  }
  return data as T;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
};

const DEFAULT_MIME = { video: "video/mp4", image: "image/png", audio: "audio/mpeg" } as const;

function mimeFor(url: string, model: ModelConfig) {
  const ext = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? DEFAULT_MIME[model.mediaType];
}

/** A Suno take as Kie returns it. `id` is the audio id that lyrics timing, extend and stem calls need. */
type SunoTrack = { id?: string; audio_url?: string; duration?: number; title?: string; tags?: string; image_url?: string; model_name?: string };

type ParsedResult = { urls: string[]; tracks?: SunoTrack[] };

/**
 * Most market models return `{ resultUrls: [...] }`. Suno returns `{ code, data: [take, take], task_id }`,
 * each take carrying its own `audio_url` (verified with a live call on 2026-09-25).
 */
function parseResult(resultJson: string | null | undefined): ParsedResult {
  if (!resultJson) return { urls: [] };
  const isUrl = (u: unknown): u is string => typeof u === "string" && u.startsWith("http");
  try {
    const parsed = JSON.parse(resultJson) as { resultUrls?: unknown[]; data?: unknown };
    if (Array.isArray(parsed.data)) {
      const tracks = (parsed.data as SunoTrack[]).filter((t) => isUrl(t?.audio_url));
      return { urls: tracks.map((t) => t.audio_url!), tracks };
    }
    return { urls: (parsed.resultUrls ?? []).filter(isUrl) };
  } catch {
    return { urls: [] };
  }
}

export const kieProvider: ProviderAdapter = {
  async start(model, params, ctx): Promise<ProviderState> {
    const endpoint = model.endpoints?.[ctx.mode] ?? model.providerModelId;
    if (!model.mapInput) return { status: "failed", error: `Model ${model.id} has no Kie input mapping`, endpoint };
    try {
      const data = await kie<{ taskId: string }>("/api/v1/jobs/createTask", {
        method: "POST",
        body: JSON.stringify({ model: endpoint, input: model.mapInput(params, ctx.mode), callBackUrl: ctx.webhookUrl }),
      });
      if (!data?.taskId) return { status: "failed", error: "Kie did not return a taskId", endpoint };
      return { status: "queued", requestId: data.taskId, endpoint };
    } catch (err) {
      return { status: "failed", error: errorMessage(err), endpoint };
    }
  },

  async poll(model, requestId, endpoint): Promise<ProviderState> {
    const record = await kie<KieTaskRecord>(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(requestId)}`);
    const base = { requestId, endpoint };

    switch (record.state) {
      case "waiting":
      case "queuing":
        return { status: "queued", ...base };
      case "generating":
        return { status: "processing", ...base };
      case "fail":
        return { status: "failed", error: [record.failCode, record.failMsg].filter(Boolean).join(": ") || "Kie reported the task failed", ...base };
      case "success": {
        const { urls, tracks } = parseResult(record.resultJson);
        if (!urls.length) return { status: "failed", error: "Kie returned no output file", ...base };
        const files: ProviderFile[] = urls.map((url) => ({ url, mimeType: mimeFor(url, model) }));
        return {
          status: "completed",
          output: {
            files,
            usage: {
              costUsd: record.creditsConsumed != null ? Math.round(record.creditsConsumed * KIE_USD_PER_CREDIT * 10000) / 10000 : undefined,
              outputDurationSeconds: tracks?.[0]?.duration,
            },
            metadata: {
              task_id: record.taskId,
              kie_model: record.model,
              credits_consumed: record.creditsConsumed,
              cost_time: record.costTime,
              ...(tracks ? { tracks: tracks.map((t) => ({ audio_id: t.id, title: t.title, duration_seconds: t.duration, style: t.tags, cover_url: t.image_url, suno_model: t.model_name })) } : {}),
            },
          },
          ...base,
        };
      }
      default:
        return { status: "processing", ...base };
    }
  },
};

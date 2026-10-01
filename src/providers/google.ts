import "server-only";
import { GoogleGenAI } from "@google/genai";
import type { ModelConfig, NormalizedParams } from "@/config/models.config";
import { env } from "@/lib/env";
import { errorMessage } from "@/lib/utils";
import type { ProviderAdapter, ProviderFile, ProviderState } from "./types";

/**
 * Google Gemini API direct — Nano Banana image models + Gemini Omni Flash video.
 * Both use the Interactions API (`ai.interactions.create`), which Google's docs now
 * recommend over generateContent for these models.
 *
 *  - Images return synchronously (a few seconds) → completed immediately.
 *  - Video runs with `background: true` and is polled via `ai.interactions.get(id)`.
 *    If background mode is rejected, we fall back to a blocking call (runs inside
 *    `after()` so the HTTP response isn't held open).
 */

let ai: GoogleGenAI | null = null;
function client() {
  if (!ai) ai = new GoogleGenAI({ apiKey: env.googleApiKey });
  return ai;
}

const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

/** Non-streaming interaction (the SDK overloads also return a Stream type). */
type Interaction = Exclude<Awaited<ReturnType<GoogleGenAI["interactions"]["get"]>>, AsyncIterable<unknown>>;
type ImageInput = { type: "image"; data: string; mime_type: string };

async function fetchImageAsInput(url: string): Promise<ImageInput> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch reference image (${res.status}): ${url}`);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_REFERENCE_BYTES) throw new Error("Reference image is larger than 20 MB");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_REFERENCE_BYTES) throw new Error("Reference image is larger than 20 MB");
  const mime = res.headers.get("content-type")?.split(";")[0] || "image/png";
  return { type: "image", data: buf.toString("base64"), mime_type: mime };
}

/**
 * `response_format.duration` is typed as a string in @google/genai 2.22 but its format
 * isn't documented yet. We send Google's standard protobuf Duration encoding ("8s").
 * If Google rejects it, this is the one place to change.
 */
function omniDuration(seconds: number | undefined) {
  return seconds ? `${seconds}s` : undefined;
}

const toApiResolution = (r?: string) => (r ? r.toLowerCase() : undefined); // "4K" → "4k"

function interactionError(it: Interaction): string {
  const errs = it.errors?.map((e) => e.message).filter(Boolean).join("; ");
  if (errs) return errs;
  if (it.output_text) return `Model returned no media: ${it.output_text.slice(0, 500)}`;
  return `Interaction ended with status "${it.status}"`;
}

function videoTokens(it: Interaction): number | undefined {
  return it.usage?.output_tokens_by_modality?.find((m) => String(m.modality).toLowerCase() === "video")?.tokens;
}

/** Turns a finished interaction into a normalized state. Handles URI-delivered files that are still processing. */
async function stateFromInteraction(model: ModelConfig, it: Interaction): Promise<ProviderState> {
  const endpoint = model.providerModelId;
  const base = { requestId: it.id, endpoint };

  if (it.status === "queued") return { status: "queued", ...base };
  if (it.status === "in_progress") return { status: "processing", ...base };
  if (it.status !== "completed") return { status: "failed", error: interactionError(it), ...base };

  const media = model.mediaType === "video" ? it.output_video : it.output_image;
  if (!media || (!media.data && !media.uri)) return { status: "failed", error: interactionError(it), ...base };

  let file: ProviderFile;
  const mimeType = media.mime_type || (model.mediaType === "video" ? "video/mp4" : "image/png");
  if (media.data) {
    file = { data: Buffer.from(media.data, "base64"), mimeType };
  } else {
    // URI delivery: the file must reach ACTIVE before it can be downloaded.
    const name = media.uri!.match(/files\/[^/:?]+/)?.[0];
    if (name) {
      const info = await client().files.get({ name });
      const state = String(info.state);
      if (state === "PROCESSING") return { status: "processing", ...base };
      if (state === "FAILED") return { status: "failed", error: info.error?.message || "Google file processing failed", ...base };
    }
    file = { url: media.uri!, fetchHeaders: { "x-goog-api-key": env.googleApiKey }, mimeType };
  }

  return {
    status: "completed",
    output: { files: [file], usage: { videoOutputTokens: videoTokens(it) }, metadata: { interaction_id: it.id, usage: it.usage } },
    ...base,
  };
}

async function buildInput(model: ModelConfig, params: NormalizedParams) {
  // Video: [start frame, end frame]. Images: reference images.
  const urls = model.mediaType === "video" ? [params.start_frame_url, params.end_frame_url].filter((u): u is string => Boolean(u)) : params.image_urls;
  const images = await Promise.all(urls.map(fetchImageAsInput));
  const parts: Array<ImageInput | { type: "text"; text: string }> = [...images];
  if (params.prompt) parts.push({ type: "text", text: params.prompt });
  return parts;
}

export const googleProvider: ProviderAdapter = {
  async start(model, params): Promise<ProviderState> {
    const endpoint = model.providerModelId;
    try {
      const input = await buildInput(model, params);

      if (model.mediaType === "image") {
        const it = await client().interactions.create(
          {
            model: model.providerModelId,
            input,
            response_format: { type: "image", aspect_ratio: params.aspect_ratio, image_size: params.resolution },
            store: false,
          },
          // No SDK retries: a refused request (e.g. a 429 quota error) should fail the job now, not after minutes of backoff.
          { timeout: 180_000, maxRetries: 0 },
        );
        return stateFromInteraction(model, it);
      }

      const request = {
        model: model.providerModelId,
        input,
        response_format: {
          type: "video" as const,
          aspect_ratio: params.aspect_ratio,
          resolution: toApiResolution(params.resolution),
          duration: omniDuration(params.duration),
          delivery: "uri" as const,
        },
      };

      try {
        const it = await client().interactions.create({ ...request, background: true }, { timeout: 120_000, maxRetries: 0 });
        return stateFromInteraction(model, it);
      } catch (err) {
        if (!/background/i.test(errorMessage(err))) throw err;
        // Background mode not supported for this model → blocking call (we're inside after()).
        const it = await client().interactions.create(request, { timeout: 280_000, maxRetries: 0 });
        return stateFromInteraction(model, it);
      }
    } catch (err) {
      return { status: "failed", error: errorMessage(err), endpoint };
    }
  },

  async poll(model, requestId): Promise<ProviderState> {
    const it = await client().interactions.get(requestId);
    return stateFromInteraction(model, it);
  },
};

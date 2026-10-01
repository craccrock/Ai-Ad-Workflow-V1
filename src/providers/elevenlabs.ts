import "server-only";
import type { NormalizedParams, SettingValue } from "@/config/models.config";
import { parseDialogue } from "@/config/models.config";
import { env } from "@/lib/env";
import { errorMessage } from "@/lib/utils";
import type { ProviderAdapter, ProviderState } from "./types";

/**
 * ElevenLabs direct. Kie resells these models too, but its ElevenLabs endpoints have been
 * failing (500s), and going direct also reaches the voices in the account's own library —
 * including cloned ones Kie can't see. Requests are synchronous: audio comes back in the body.
 */

const API = "https://api.elevenlabs.io/v1";
/** 128 kbps MP3: plenty for voiceover, a fraction of WAV's size in Supabase storage. */
const OUTPUT_FORMAT = "mp3_44100_128";
const TIMEOUT_MS = 120_000;

const setting = <T extends SettingValue>(p: NormalizedParams, key: string) => p.settings?.[key] as T | undefined;
const num = (v: SettingValue | undefined) => (v == null || v === "" ? undefined : Number(v));

export type AccountVoice = { id: string; name: string; hint?: string; previewUrl?: string };

type VoicesResponse = { voices?: { voice_id: string; name?: string; category?: string; preview_url?: string; labels?: Record<string, string> }[] };

let voiceCache: { at: number; voices: AccountVoice[] } | null = null;
const VOICE_TTL_MS = 10 * 60 * 1000;

/** The voices in the account's library (cloned ones included), newest cache at most 10 minutes old. */
export async function accountVoices(): Promise<AccountVoice[]> {
  if (voiceCache && Date.now() - voiceCache.at < VOICE_TTL_MS) return voiceCache.voices;
  const res = await fetch(`${API.replace("/v1", "/v2")}/voices?page_size=100`, {
    headers: { "xi-api-key": env.elevenLabsApiKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs voices: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as VoicesResponse;
  const voices = (data.voices ?? []).map((v) => ({
    id: v.voice_id,
    name: v.name ?? v.voice_id,
    hint: [v.labels?.description, v.labels?.gender, v.labels?.accent, v.category === "cloned" ? "your clone" : undefined].filter(Boolean).join(" · ") || undefined,
    previewUrl: v.preview_url,
  }));
  voiceCache = { at: Date.now(), voices };
  return voices;
}

/** "Liam: hello" → a voice id from the account library (name match, case-insensitive, or a raw id). */
async function resolveDialogue(prompt: string) {
  const { turns, errors } = parseDialogue(prompt, { requireKnownVoice: false });
  if (errors.length) throw new Error(errors.join(" "));
  const voices = await accountVoices();
  const byName = new Map(voices.map((v) => [v.name.toLowerCase(), v.id]));
  const ids = new Set(voices.map((v) => v.id));
  return turns.map((t) => {
    const voiceId = ids.has(t.voice) ? t.voice : byName.get(t.voice.toLowerCase());
    if (!voiceId) throw new Error(`No voice called "${t.voice}" in your ElevenLabs library. Voices: ${voices.slice(0, 8).map((v) => v.name).join(", ")}…`);
    return { text: t.text, voice_id: voiceId };
  });
}

/** ElevenLabs errors are JSON like { detail: { status, message } } — dig out something readable. */
async function readError(res: Response): Promise<string> {
  const body = await res.text();
  try {
    const parsed = JSON.parse(body) as { detail?: { status?: string; message?: string } | string };
    const detail = parsed.detail;
    if (typeof detail === "string") return `${res.status}: ${detail}`;
    if (detail?.message) return `${res.status}: ${detail.message}${detail.status ? ` (${detail.status})` : ""}`;
  } catch {
    /* not JSON */
  }
  return `${res.status}: ${body.slice(0, 200) || res.statusText}`;
}

async function audioRequest(url: string, body: unknown, endpoint: string): Promise<ProviderState> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": env.elevenLabsApiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return { status: "failed", error: await readError(res), endpoint };

  const data = Buffer.from(await res.arrayBuffer());
  if (!data.byteLength) return { status: "failed", error: "ElevenLabs returned an empty audio file", endpoint };
  return {
    status: "completed",
    endpoint,
    output: {
      files: [{ data, mimeType: "audio/mpeg" }],
      usage: {},
      metadata: { characters: res.headers.get("character-cost") ?? undefined, request_id: res.headers.get("request-id") ?? undefined },
    },
  };
}

export const elevenLabsProvider: ProviderAdapter = {
  async start(model, params): Promise<ProviderState> {
    const endpoint = model.providerModelId;
    try {
      const stability = num(setting(params, "stability"));
      const similarity = num(setting(params, "similarity_boost"));

      if (model.inputTypes.includes("text-to-dialogue")) {
        return await audioRequest(
          `${API}/text-to-dialogue?output_format=${OUTPUT_FORMAT}`,
          {
            inputs: await resolveDialogue(params.prompt ?? ""),
            model_id: endpoint,
            settings: { stability, similarity },
          },
          endpoint,
        );
      }

      const voice = setting<string>(params, "voice");
      if (!voice) return { status: "failed", error: "Pick a voice first", endpoint };
      return await audioRequest(
        `${API}/text-to-speech/${encodeURIComponent(voice)}?output_format=${OUTPUT_FORMAT}`,
        {
          text: params.prompt,
          model_id: endpoint,
          voice_settings: {
            stability,
            similarity_boost: similarity,
            style: num(setting(params, "style")),
            speed: num(setting(params, "speed")),
            use_speaker_boost: true,
          },
          language_code: setting<string>(params, "language_code") || undefined,
        },
        endpoint,
      );
    } catch (err) {
      return { status: "failed", error: errorMessage(err), endpoint };
    }
  },

  // Nothing to poll: ElevenLabs answers with the audio itself.
  async poll(_model, _requestId, endpoint): Promise<ProviderState> {
    return { status: "failed", error: "ElevenLabs jobs finish on submit; nothing to poll", endpoint };
  },
};

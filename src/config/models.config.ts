/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MODEL CONFIGURATION — single source of truth
 * ═══════════════════════════════════════════════════════════════════════════
 * The UI (picker + dynamic form), cost estimator, API validation AND provider
 * routing all read from this file. To add a model or change a price, edit here.
 *
 * `provider` decides which pipe a generation goes through:
 *   - "kie"    → Kie.ai jobs API. Primary for every model (cheapest as of 2026-09).
 *   - "google" → Gemini API direct (@google/genai). Used as the automatic `fallback`
 *                for Google models when Kie rejects, fails or stalls a job.
 *
 * Kie prices are credits × $0.005, from Kie's pricing API on 2026-09-14 (audio models: 2026-09-25).
 * Google prices from ai.google.dev/gemini-api/docs/pricing on the same date.
 * `mapInput` translates normalized form params into each Kie model's `input` schema
 * (Google request building lives in providers/google.ts).
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { GenerationParams } from "@/lib/types";
import { ELEVENLABS_VOICES } from "./elevenlabs-voices";

export type Provider = "kie" | "google" | "elevenlabs";
export type Category = "video" | "avatar" | "image" | "audio" | "upscale";
export type InputType =
  | "text-to-video"
  | "image-to-video"
  | "reference-to-video"
  | "audio-to-video"
  | "text-to-image"
  | "image-edit"
  | "image-upscale"
  | "video-upscale"
  | "text-to-music"
  | "text-to-speech"
  | "text-to-dialogue";

/** Kie bills in credits; one credit is $0.005 at list price. */
export const KIE_USD_PER_CREDIT = 0.005;
const cr = (credits: number) => Math.round(credits * KIE_USD_PER_CREDIT * 10000) / 10000;

export type Pricing =
  | {
      unit: "per_second";
      /** USD per output second, keyed by resolution (or "default"). */
      rates: Record<string, number>;
      /** Alternate rates when `generate_audio` is on. */
      audioRates?: Record<string, number>;
      /** Where billable seconds come from. Default: the `duration` param. */
      durationFrom?: "duration" | "audio" | "source_video";
      /** Rates when reference videos are supplied (Kie bills these differently). */
      videoInputRates?: Record<string, number>;
      /** Extra USD per input image (start/end frames + reference images). */
      perInputImage?: number;
      /** Google token billing: USD per 1M video output tokens, used for actual cost when usage is reported. */
      videoOutputTokenRatePerMillion?: number;
      note?: string;
    }
  | {
      /** Flat price per clip. Keys: "<resolution>|<duration>", with "*" as a wildcard on either side. */
      unit: "per_video";
      rates: Record<string, number>;
      /** Flat price per clip when reference videos are supplied, keyed by resolution or "*". */
      videoInputRates?: Record<string, number>;
      note?: string;
    }
  | {
      unit: "per_image";
      rates: Record<string, number>;
      /** Google Batch API (~50% off). Not wired up yet — kept for future optimization. */
      batchRates?: Record<string, number>;
      note?: string;
    }
  | { unit: "flat"; amount: number; note?: string }
  | {
      /** Speech: USD per 1,000 characters of text (Kie bills by character). */
      unit: "per_1k_chars";
      rates: Record<string, number>;
      note?: string;
    };

/**
 * A model-specific setting shown in the form and sent as `params.settings[key]` (e.g. a song's style, a voice).
 * Validated and defaulted in lib/generation-params.ts; read by the model's `mapInput`.
 */
export type SettingValue = string | number | boolean;
export type FieldSpec = {
  key: string;
  label: string;
  type: "text" | "textarea" | "select" | "toggle" | "number";
  options?: { value: string; label?: string; hint?: string }[];
  default?: SettingValue;
  required?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  help?: string;
  /** Options come from the account at runtime (the ElevenLabs voice library) rather than this file. */
  optionsFrom?: "voices";
  /** Hidden (and not sent) unless this returns true for the current settings. */
  showIf?: (settings: Record<string, SettingValue | undefined>) => boolean;
  /** Tucked under "Advanced" in the form. */
  advanced?: boolean;
};

export type ModelOptions = {
  durations?: number[];
  defaultDuration?: number;
  resolutions?: string[];
  defaultResolution?: string;
  aspectRatios?: string[];
  defaultAspectRatio?: string;
  /** Aspect ratio is ignored when a start frame is supplied (the frame's shape wins). */
  aspectRatioTextOnly?: boolean;
  /** Shows a "Generate audio" toggle (native sound/dialogue). */
  audioToggle?: boolean;
  defaultGenerateAudio?: boolean;
  /** Image models, avatars, upscalers: max images in `image_urls`. 0 or undefined = none. */
  maxImages?: number;
  /** Labels for those image slots, e.g. ["Face image"]. */
  imageSlotLabels?: string[];
  /** Video models: which frames and references the provider accepts. */
  references?: ReferenceSpec;
  supportsNegativePrompt?: boolean;
  supportsSeed?: boolean;
  /** Model-specific settings (see FieldSpec). */
  fields?: FieldSpec[];
  /** What the prompt box means for this model, e.g. "Lyrics" or "Script". */
  promptLabel?: string;
  promptPlaceholder?: string;
  /** Max prompt length, when the provider's is below the app-wide 8000. */
  promptMaxLength?: number;
};

export type ReferenceSpec = {
  /** Start frame only, or start + optional end frame. */
  frames?: "start" | "start-end";
  images?: { max: number };
  videos?: { max: number; minSeconds?: number; maxSeconds?: number; maxTotalSeconds?: number };
  audios?: { max: number; maxTotalSeconds?: number; /** Can't be the only reference. */ requiresVisual?: boolean };
  /** Kling 3.0 elements: named subjects referenced in the prompt as @name. */
  elements?: { max: number; minImages: number; maxImages: number; requiresStartFrame?: boolean };
  /** Frames and multimodal references can't be combined in one request. */
  framesExclusive?: boolean;
  /** Shared slot budget, e.g. Omni: images + 2 × videos ≤ 7. */
  slotBudget?: { max: number; videoWeight: number };
};

export type Fallback = {
  provider: Provider;
  providerModelId: string;
  pricing: Pricing;
  /** Whether the backup can run these params. Default: always. */
  supports?: (p: NormalizedParams) => boolean;
};

export type ModelConfig = {
  id: string;
  provider: Provider;
  /** Default model string sent to the provider. */
  providerModelId: string;
  /** Per-mode model strings (e.g. Kie's separate text vs image models). Falls back to providerModelId. */
  endpoints?: Partial<Record<InputType, string>>;
  /** Automatic backup when the primary provider rejects, fails or stalls a job. */
  fallback?: Fallback;
  name: string;
  description: string;
  category: Category;
  mediaType: "video" | "image" | "audio";
  inputTypes: InputType[];
  /** Models sharing a family render as one card with a Quality Tier switch. */
  family?: string;
  tier?: string;
  requiresPrompt?: boolean;
  requiresImage?: boolean;
  requiresAudio?: boolean;
  requiresVideo?: boolean;
  pricing: Pricing;
  options: ModelOptions;
  mapInput?: (p: NormalizedParams, mode: InputType) => Record<string, unknown>;
  /** Extra model-specific rules (e.g. aspect ratios a resolution can't do). Returns error messages. */
  validate?: (p: NormalizedParams) => string[];
};

/** Params after validation/defaulting (see lib/generation-params.ts). */
export type NormalizedParams = GenerationParams & {
  settings: Record<string, SettingValue>;
  image_urls: string[];
  reference_image_urls: string[];
  reference_video_urls: string[];
  reference_audio_urls: string[];
  elements: NonNullable<GenerationParams["elements"]>;
};

const has = (list?: unknown[]) => Boolean(list && list.length);
/** Undefined for empty lists, so optional array fields are left out of provider requests. */
const nonEmpty = <T,>(list?: T[]) => (list && list.length ? list : undefined);

// ─── helpers for Kie input mapping ──────────────────────────────────────────
/** Drops undefined fields, then merges the caller's raw `extra` fields last. */
const withExtra = (p: NormalizedParams, input: Record<string, unknown>) => {
  const cleaned = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  return { ...cleaned, ...(p.extra ?? {}) };
};

const VIDEO_ASPECTS = ["16:9", "9:16", "1:1"];
const SEEDANCE_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"];
/** Supported by both Kie's Nano Banana models and Google direct, so fallback never rejects them. */
const NANO_BANANA_ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

const omniVideoRates = (cols: Record<string, number>, fourK: Record<string, number>) =>
  Object.fromEntries([
    ...Object.entries(cols).map(([d, c]) => [`*|${d}`, cr(c)]),
    ...Object.entries(fourK).map(([d, c]) => [`4K|${d}`, cr(c)]),
  ]);

function kling3(tier: "Standard" | "Pro" | "4K", mode: "std" | "pro" | "4K", rates: { off: number; on: number }): ModelConfig {
  return {
    id: `kling-3-${mode.toLowerCase()}`,
    provider: "kie",
    providerModelId: "kling-3.0/video",
    name: "Kling 3.0",
    description: "Kling's flagship. Strong motion and native audio.",
    category: "video",
    mediaType: "video",
    family: "kling-3",
    tier,
    inputTypes: ["text-to-video", "image-to-video"],
    requiresPrompt: true,
    pricing: { unit: "per_second", rates: { default: cr(rates.off) }, audioRates: { default: cr(rates.on) } },
    options: {
      durations: [5, 10, 15],
      defaultDuration: 5,
      aspectRatios: VIDEO_ASPECTS,
      defaultAspectRatio: "9:16",
      aspectRatioTextOnly: true,
      audioToggle: true,
      defaultGenerateAudio: false,
      references: { frames: "start-end", elements: { max: 3, minImages: 2, maxImages: 4, requiresStartFrame: true } },
    },
    mapInput: (p) =>
      withExtra(p, {
        prompt: p.prompt,
        image_urls: nonEmpty([p.start_frame_url, p.end_frame_url].filter((u): u is string => Boolean(u))),
        sound: Boolean(p.generate_audio),
        duration: String(p.duration),
        aspect_ratio: p.aspect_ratio,
        mode,
        multi_shots: false,
        multi_prompt: [],
        kling_elements: nonEmpty(
          p.elements.map((e) => ({ name: e.name, description: e.description || e.name, element_input_urls: e.image_urls })),
        ),
      }),
  };
}

type SeedanceSpec = {
  id: string;
  model: string;
  name: string;
  description: string;
  family?: string;
  tier?: string;
  resolutions: string[];
  rates: Record<string, number>;
  videoInputRates: Record<string, number>;
  durations: number[];
  references: ReferenceSpec;
};

function seedance(spec: SeedanceSpec): ModelConfig {
  return {
    id: spec.id,
    provider: "kie",
    providerModelId: spec.model,
    name: spec.name,
    description: spec.description,
    category: "video",
    mediaType: "video",
    family: spec.family,
    tier: spec.tier,
    inputTypes: ["text-to-video", "image-to-video", "reference-to-video"],
    requiresPrompt: true,
    pricing: { unit: "per_second", rates: spec.rates, videoInputRates: spec.videoInputRates },
    options: {
      durations: spec.durations,
      defaultDuration: spec.durations[0],
      resolutions: spec.resolutions,
      defaultResolution: "720p",
      aspectRatios: SEEDANCE_ASPECTS,
      defaultAspectRatio: "9:16",
      audioToggle: true,
      defaultGenerateAudio: true,
      references: spec.references,
    },
    // One Kie model string handles text, frames and references. (Seedance Fast's schema lists the
    // video field with a trailing space, but its own example request uses the normal key sent here.)
    mapInput: (p) =>
      withExtra(p, {
        prompt: p.prompt,
        first_frame_url: p.start_frame_url,
        last_frame_url: p.end_frame_url,
        reference_image_urls: nonEmpty(p.reference_image_urls),
        reference_video_urls: nonEmpty(p.reference_video_urls),
        reference_audio_urls: nonEmpty(p.reference_audio_urls),
        generate_audio: Boolean(p.generate_audio),
        resolution: p.resolution,
        aspect_ratio: p.aspect_ratio,
        duration: p.duration,
      }),
  };
}

// ─── audio helpers ──────────────────────────────────────────────────────────
const setting = <T extends SettingValue>(p: NormalizedParams, key: string) => p.settings[key] as T | undefined;
const sunoCustom = (s: Record<string, SettingValue | undefined>) => s.mode !== "describe";

const voiceByName = new Map<string, string>();
for (const v of ELEVENLABS_VOICES) if (!voiceByName.has(v.name.toLowerCase())) voiceByName.set(v.name.toLowerCase(), v.id);

/**
 * Dialogue scripts are one turn per line, "Voice: line".
 * With `requireKnownVoice` the name must match a bundled preset; the ElevenLabs provider turns it
 * off and resolves names against the account's own library instead.
 */
export function parseDialogue(script = "", opts: { requireKnownVoice?: boolean } = {}): { turns: { voice: string; text: string }[]; errors: string[] } {
  const requireKnownVoice = opts.requireKnownVoice ?? true;
  const turns: { voice: string; text: string }[] = [];
  const errors: string[] = [];
  for (const [i, raw] of script.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^([^:]{1,60}):\s*(.+)$/);
    const who = match?.[1].trim() ?? "";
    const known = ELEVENLABS_VOICES.some((v) => v.id === who) ? who : voiceByName.get(who.toLowerCase());
    const voice = requireKnownVoice ? known : known ?? who;
    if (!match || !voice) {
      errors.push(`Line ${i + 1}: start with a voice name, e.g. "Liam: …"${match ? ` ("${who}" isn't a preset voice)` : ""}.`);
      continue;
    }
    turns.push({ voice, text: match[2].trim() });
  }
  if (!turns.length && !errors.length) errors.push("Add at least one line, e.g. \"Liam: …\".");
  return { turns, errors };
}

/** Characters that get billed: the spoken text (dialogue lines without their "Voice:" prefixes). */
export function billableCharacters(model: Pick<ModelConfig, "inputTypes">, prompt = ""): number {
  if (model.inputTypes.includes("text-to-dialogue")) return parseDialogue(prompt, { requireKnownVoice: false }).turns.reduce((n, t) => n + t.text.length, 0);
  return prompt.length;
}

/**
 * ElevenLabs direct (not through Kie): reaches the account's own voice library, including clones,
 * and returns audio in one synchronous call. Prices are ElevenLabs' published per-character rates;
 * in practice the characters come out of the monthly plan allowance.
 */
/**
 * OpenAI's GPT Image 2.5 on Kie, in two flavours Kie doesn't document a difference for.
 * Unlike GPT Image 2 there are no aspect-ratio-per-resolution restrictions, and it can
 * render a transparent background.
 */
function gptImage25(tier: "Flare" | "Sunburst", slug: string): ModelConfig {
  return {
    id: `gpt-image-2-5-${tier.toLowerCase()}`,
    provider: "kie",
    providerModelId: `${slug}-text-to-image`,
    endpoints: { "text-to-image": `${slug}-text-to-image`, "image-edit": `${slug}-image-to-image` },
    name: "GPT Image 2.5",
    description: "OpenAI's newest. Strong prompt following and in-image text, transparent backgrounds, up to 16 reference images.",
    category: "image",
    mediaType: "image",
    family: "gpt-image-2-5",
    tier,
    inputTypes: ["text-to-image", "image-edit"],
    requiresPrompt: true,
    pricing: { unit: "per_image", rates: { "1K": cr(6), "2K": cr(10), "4K": cr(16) } },
    options: {
      resolutions: ["1K", "2K", "4K"],
      defaultResolution: "2K",
      aspectRatios: ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9", "27:16", "16:27", "9:8", "8:9", "auto"],
      defaultAspectRatio: "1:1",
      maxImages: 16,
      fields: [
        {
          key: "background",
          label: "Background",
          type: "select",
          default: "auto",
          options: [
            { value: "auto", label: "Auto" },
            { value: "opaque", label: "Opaque" },
            { value: "transparent", label: "Transparent", hint: "Cut-out PNG for product shots" },
          ],
        },
      ],
    },
    mapInput: (p, mode) =>
      withExtra(p, {
        prompt: p.prompt,
        aspect_ratio: p.aspect_ratio,
        resolution: p.resolution,
        background: setting<string>(p, "background"),
        input_urls: mode === "image-edit" ? p.image_urls : undefined,
      }),
  };
}

function elevenLabsTts(tier: "v3" | "Multilingual v2" | "Flash 2.5", modelId: string, usdPer1k: number, description: string): ModelConfig {
  return {
    id: `elevenlabs-${modelId.replace(/^eleven_/, "").replace(/_/g, "-")}`,
    provider: "elevenlabs",
    providerModelId: modelId,
    name: "ElevenLabs Voice",
    description,
    category: "audio",
    mediaType: "audio",
    family: "elevenlabs-tts",
    tier,
    inputTypes: ["text-to-speech"],
    requiresPrompt: true,
    pricing: { unit: "per_1k_chars", rates: { default: usdPer1k }, note: "Drawn from your ElevenLabs plan allowance." },
    options: {
      promptLabel: "Script",
      promptPlaceholder: "The words to speak, exactly as they should be read…",
      promptMaxLength: tier === "v3" ? 3000 : 5000,
      fields: [
        { key: "voice", label: "Voice", type: "select", optionsFrom: "voices", options: [], required: true, help: "Every voice in your ElevenLabs library, clones included." },
        { key: "speed", label: "Speed", type: "number", min: 0.7, max: 1.2, step: 0.05, default: 1 },
        { key: "stability", label: "Stability", type: "number", min: 0, max: 1, step: 0.05, default: 0.5, advanced: true, help: "Lower = more expressive, higher = more consistent." },
        { key: "similarity_boost", label: "Similarity", type: "number", min: 0, max: 1, step: 0.05, default: 0.75, advanced: true },
        { key: "style", label: "Style exaggeration", type: "number", min: 0, max: 1, step: 0.05, default: 0, advanced: true },
        { key: "language_code", label: "Language code", type: "text", maxLength: 5, placeholder: "en", advanced: true, help: "ISO 639-1, e.g. en, es, de. Leave empty to auto-detect." },
      ],
    },
  };
}

const SEEDANCE_2_REFERENCES: ReferenceSpec = {
  frames: "start-end",
  images: { max: 9 },
  videos: { max: 3, minSeconds: 2, maxSeconds: 15, maxTotalSeconds: 15 },
  audios: { max: 3, maxTotalSeconds: 15 },
  framesExclusive: true,
};

// ─── models ─────────────────────────────────────────────────────────────────
export const models: ModelConfig[] = [
  // ═══════════════════════════════════════════════════════
  // GOOGLE MODELS — Kie primary, Google direct as backup
  // ═══════════════════════════════════════════════════════
  {
    id: "gemini-omni-1.1-flash",
    provider: "kie",
    providerModelId: "google/gemini-omni-flash-1-1",
    fallback: {
      provider: "google",
      providerModelId: "gemini-omni-1.1-flash",
      // $17.50 / 1M video output tokens ≈ 5,792 tokens/sec at 720p
      pricing: { unit: "per_second", rates: { "360p": 0.034, "720p": 0.101, "1080p": 0.152, "4K": 0.304 }, videoOutputTokenRatePerMillion: 17.5 },
      // The Google backup is wired for text and start/end frames only.
      supports: (p) => !has(p.reference_image_urls) && !has(p.reference_video_urls),
    },
    name: "Gemini Omni Flash 1.1",
    description: "Google's multimodal video model. Best quality-to-cost ratio for video.",
    category: "video",
    mediaType: "video",
    inputTypes: ["text-to-video", "image-to-video", "reference-to-video"],
    requiresPrompt: true,
    pricing: {
      unit: "per_video",
      // 360p–1080p share a price on Kie; 4K costs more. A reference video makes it a flat price per clip.
      rates: omniVideoRates({ 4: 63, 6: 84, 8: 105, 10: 126 }, { 4: 147, 6: 168, 8: 189, 10: 210 }),
      videoInputRates: { "*": cr(168), "4K": cr(252) },
    },
    options: {
      durations: [4, 6, 8, 10],
      defaultDuration: 8,
      resolutions: ["360p", "720p", "1080p", "4K"],
      defaultResolution: "720p",
      aspectRatios: ["16:9", "9:16"], // API supports only these two
      defaultAspectRatio: "9:16",
      supportsSeed: true,
      references: {
        frames: "start-end",
        images: { max: 7 },
        videos: { max: 1, maxSeconds: 30 },
        framesExclusive: true,
        slotBudget: { max: 7, videoWeight: 2 },
      },
    },
    mapInput: (p) =>
      withExtra(p, {
        prompt: p.prompt,
        duration: String(p.duration),
        resolution: p.resolution?.toLowerCase(), // "4K" → "4k"
        aspect_ratio: p.aspect_ratio,
        first_frame_url: p.start_frame_url,
        last_frame_url: p.end_frame_url,
        image_urls: nonEmpty(p.reference_image_urls),
        // Kie needs a trim window of at most 10s per clip; use the start of each video.
        video_list: nonEmpty(
          p.reference_video_urls.map((url, i) => ({ url, start: 0, ends: Math.min(10, p.reference_video_durations?.[i] ?? 10) })),
        ),
        seed: p.seed,
      }),
  },
  {
    id: "nano-banana-pro",
    provider: "kie",
    providerModelId: "nano-banana-pro",
    fallback: {
      provider: "google",
      providerModelId: "gemini-3-pro-image",
      pricing: { unit: "per_image", rates: { "1K": 0.134, "2K": 0.134, "4K": 0.24 }, batchRates: { "1K": 0.067, "2K": 0.067, "4K": 0.12 } },
    },
    name: "Nano Banana Pro",
    description: "Google's premium image model. Best for complex scenes, text, brand work.",
    category: "image",
    mediaType: "image",
    inputTypes: ["text-to-image", "image-edit"],
    requiresPrompt: true,
    pricing: { unit: "per_image", rates: { "1K": cr(18), "2K": cr(18), "4K": cr(24) } },
    options: {
      resolutions: ["1K", "2K", "4K"],
      defaultResolution: "2K",
      aspectRatios: NANO_BANANA_ASPECTS,
      defaultAspectRatio: "1:1",
      maxImages: 8, // Kie's max; within Google's 6 object + 5 character references for the backup
    },
    mapInput: (p) =>
      withExtra(p, {
        prompt: p.prompt,
        image_input: p.image_urls,
        aspect_ratio: p.aspect_ratio,
        resolution: p.resolution,
        output_format: "png",
      }),
  },
  {
    id: "nano-banana-2",
    provider: "kie",
    providerModelId: "nano-banana-2",
    fallback: {
      provider: "google",
      providerModelId: "gemini-3.1-flash-image",
      pricing: { unit: "per_image", rates: { "1K": 0.067, "2K": 0.101, "4K": 0.151 }, batchRates: { "1K": 0.034, "2K": 0.05, "4K": 0.076 } },
    },
    name: "Nano Banana 2",
    description: "Fast image generation. Good text rendering, cheaper than Pro.",
    category: "image",
    mediaType: "image",
    inputTypes: ["text-to-image", "image-edit"],
    requiresPrompt: true,
    pricing: { unit: "per_image", rates: { "1K": cr(8), "2K": cr(12), "4K": cr(18) } },
    options: {
      resolutions: ["1K", "2K", "4K"],
      defaultResolution: "1K",
      aspectRatios: NANO_BANANA_ASPECTS,
      defaultAspectRatio: "1:1",
      maxImages: 14, // Kie's max; Google allows 10 object + 4 character references
    },
    mapInput: (p) =>
      withExtra(p, {
        prompt: p.prompt,
        image_input: p.image_urls,
        aspect_ratio: p.aspect_ratio,
        resolution: p.resolution,
        output_format: "png",
      }),
  },
  {
    id: "nano-banana-2-lite",
    provider: "kie",
    providerModelId: "nano-banana-2-lite",
    fallback: {
      provider: "google",
      providerModelId: "gemini-3.1-flash-lite-image",
      pricing: { unit: "per_image", rates: { "1K": 0.0336 } },
    },
    name: "Nano Banana 2 Lite",
    description: "Cheapest Google image model. Fast, 1K only. Great for concept drafts.",
    category: "image",
    mediaType: "image",
    inputTypes: ["text-to-image", "image-edit"],
    requiresPrompt: true,
    pricing: { unit: "per_image", rates: { "1K": cr(4) } },
    options: {
      resolutions: ["1K"],
      defaultResolution: "1K",
      aspectRatios: NANO_BANANA_ASPECTS,
      defaultAspectRatio: "1:1",
      maxImages: 10,
    },
    mapInput: (p) => withExtra(p, { prompt: p.prompt, image_urls: p.image_urls, aspect_ratio: p.aspect_ratio }),
  },

  // ═══════════════════════════════════════════════════════
  // KIE ONLY — no backup provider
  // ═══════════════════════════════════════════════════════

  // ── Video ──
  kling3("Standard", "std", { off: 14, on: 20 }),
  kling3("Pro", "pro", { off: 18, on: 27 }),
  kling3("4K", "4K", { off: 67, on: 67 }),
  {
    id: "kling-2.6",
    provider: "kie",
    providerModelId: "kling-2.6/text-to-video",
    endpoints: { "text-to-video": "kling-2.6/text-to-video", "image-to-video": "kling-2.6/image-to-video" },
    name: "Kling 2.6",
    description: "Previous-gen Kling. Cheaper per second, reliable image-to-video.",
    category: "video",
    mediaType: "video",
    inputTypes: ["text-to-video", "image-to-video"],
    requiresPrompt: true,
    pricing: { unit: "per_second", rates: { default: cr(11) }, audioRates: { default: cr(22) } },
    options: {
      durations: [5, 10],
      defaultDuration: 5,
      aspectRatios: VIDEO_ASPECTS,
      defaultAspectRatio: "9:16",
      aspectRatioTextOnly: true,
      audioToggle: true,
      defaultGenerateAudio: false,
      references: { frames: "start" },
    },
    mapInput: (p, mode) =>
      withExtra(
        p,
        mode === "image-to-video"
          ? { prompt: p.prompt, image_urls: [p.start_frame_url], sound: Boolean(p.generate_audio), duration: String(p.duration) }
          : { prompt: p.prompt, sound: Boolean(p.generate_audio), duration: String(p.duration), aspect_ratio: p.aspect_ratio },
      ),
  },
  seedance({
    id: "seedance-2-fast",
    model: "bytedance/seedance-2-fast",
    name: "Seedance 2.0",
    description: "ByteDance's cinematic model. Premium motion realism with native audio.",
    family: "seedance-2",
    tier: "Fast",
    resolutions: ["480p", "720p"],
    rates: { "480p": cr(11.7), "720p": cr(24.8) },
    videoInputRates: { "480p": cr(6.8), "720p": cr(15) },
    durations: [5, 8, 10, 15],
    references: SEEDANCE_2_REFERENCES,
  }),
  seedance({
    id: "seedance-2",
    model: "bytedance/seedance-2",
    name: "Seedance 2.0",
    description: "ByteDance's cinematic model. Premium motion realism with native audio.",
    family: "seedance-2",
    tier: "Pro",
    resolutions: ["480p", "720p", "1080p"],
    rates: { "480p": cr(19), "720p": cr(41), "1080p": cr(102) },
    videoInputRates: { "480p": cr(11.5), "720p": cr(25), "1080p": cr(62) },
    durations: [5, 8, 10, 15],
    references: SEEDANCE_2_REFERENCES,
  }),
  seedance({
    id: "seedance-2.5",
    model: "bytedance/seedance-2-5",
    name: "Seedance 2.5",
    description: "ByteDance's newest. Longer clips (up to 30s) and far more references.",
    resolutions: ["480p", "720p", "1080p"],
    rates: { "480p": cr(28), "720p": cr(63), "1080p": cr(114) },
    videoInputRates: { "480p": cr(17), "720p": cr(38), "1080p": cr(68.5) },
    durations: [5, 8, 10, 15, 20, 30],
    references: {
      frames: "start-end",
      images: { max: 30 },
      videos: { max: 10, minSeconds: 2, maxSeconds: 30, maxTotalSeconds: 30 },
      audios: { max: 10, maxTotalSeconds: 30 },
      framesExclusive: true,
    },
  }),
  {
    id: "hailuo-h3",
    provider: "kie",
    providerModelId: "minimax-h3/text-to-video",
    endpoints: {
      "text-to-video": "minimax-h3/text-to-video",
      "image-to-video": "minimax-h3/image-to-video",
      "reference-to-video": "minimax-h3/reference-to-video",
    },
    name: "Hailuo H3",
    description: "MiniMax's latest. Very cheap at 768p — good for volume and drafts.",
    category: "video",
    mediaType: "video",
    inputTypes: ["text-to-video", "image-to-video", "reference-to-video"],
    requiresPrompt: true,
    pricing: { unit: "per_second", rates: { "768P": cr(8), "2K": cr(13) }, perInputImage: cr(4) },
    options: {
      durations: [6, 10, 15],
      defaultDuration: 6,
      resolutions: ["768P", "2K"],
      defaultResolution: "768P",
      aspectRatios: VIDEO_ASPECTS,
      defaultAspectRatio: "9:16",
      aspectRatioTextOnly: true,
      references: {
        frames: "start-end",
        images: { max: 9 },
        videos: { max: 3, minSeconds: 2, maxSeconds: 15, maxTotalSeconds: 15 },
        audios: { max: 3, maxTotalSeconds: 15, requiresVisual: true },
        framesExclusive: true,
      },
    },
    mapInput: (p, mode) => {
      const base = { prompt: p.prompt, duration: p.duration, resolution: p.resolution };
      if (mode === "image-to-video") return withExtra(p, { ...base, first_frame_url: p.start_frame_url, last_frame_url: p.end_frame_url });
      if (mode === "reference-to-video") {
        return withExtra(p, {
          ...base,
          aspect_ratio: p.aspect_ratio,
          reference_image_urls: nonEmpty(p.reference_image_urls),
          reference_video_urls: nonEmpty(p.reference_video_urls),
          reference_audio_urls: nonEmpty(p.reference_audio_urls),
        });
      }
      return withExtra(p, { ...base, aspect_ratio: p.aspect_ratio });
    },
  },

  // ── Avatar / talking head ──
  {
    id: "kling-avatar-standard",
    provider: "kie",
    providerModelId: "kling/ai-avatar-standard",
    name: "Kling AI Avatar",
    description: "Audio-driven talking-head avatars. Lip-synced to your voiceover.",
    category: "avatar",
    mediaType: "video",
    family: "kling-avatar",
    tier: "Standard",
    inputTypes: ["audio-to-video"],
    requiresPrompt: false,
    requiresImage: true,
    requiresAudio: true,
    pricing: { unit: "per_second", rates: { default: cr(8) }, durationFrom: "audio", note: "720p" },
    options: { maxImages: 1, imageSlotLabels: ["Face image"] },
    mapInput: (p) => withExtra(p, { image_url: p.image_urls[0], audio_url: p.audio_url, prompt: p.prompt ?? "" }),
  },
  {
    id: "kling-avatar-pro",
    provider: "kie",
    providerModelId: "kling/ai-avatar-pro",
    name: "Kling AI Avatar",
    description: "Audio-driven talking-head avatars. Lip-synced to your voiceover.",
    category: "avatar",
    mediaType: "video",
    family: "kling-avatar",
    tier: "Pro",
    inputTypes: ["audio-to-video"],
    requiresPrompt: false,
    requiresImage: true,
    requiresAudio: true,
    pricing: { unit: "per_second", rates: { default: cr(16) }, durationFrom: "audio", note: "1080p" },
    options: { maxImages: 1, imageSlotLabels: ["Face image"] },
    mapInput: (p) => withExtra(p, { image_url: p.image_urls[0], audio_url: p.audio_url, prompt: p.prompt ?? "" }),
  },

  // ── Audio ──
  {
    id: "suno",
    provider: "kie",
    providerModelId: "ai-music-api/generate",
    name: "Suno V6",
    description: "Full songs, sung or instrumental, 10s to 6 min. Every run returns 2 takes.",
    category: "audio",
    mediaType: "audio",
    inputTypes: ["text-to-music"],
    requiresPrompt: false,
    pricing: { unit: "flat", amount: cr(12), note: "Per run; each run returns 2 takes." },
    options: {
      promptLabel: "Lyrics",
      promptPlaceholder: "[Verse]\nLyrics here…\n[Chorus]\n…\n\n(In \"Describe it\" mode: describe the song instead.)",
      promptMaxLength: 5000,
      fields: [
        {
          key: "mode",
          label: "Mode",
          type: "select",
          default: "custom",
          options: [
            { value: "custom", label: "Write lyrics", hint: "You write the lyrics and set the length" },
            { value: "describe", label: "Describe it", hint: "Suno writes lyrics from your description" },
          ],
        },
        { key: "style", label: "Style", type: "textarea", required: true, maxLength: 1000, placeholder: "warm acoustic pop, female vocal, 100 bpm, cozy and upbeat" },
        { key: "title", label: "Title", type: "text", maxLength: 80, placeholder: "Untitled", showIf: sunoCustom },
        { key: "duration", label: "Length (seconds)", type: "number", min: 10, max: 360, step: 1, default: 30, showIf: sunoCustom },
        { key: "instrumental", label: "Instrumental (no vocals)", type: "toggle", default: false },
        {
          key: "vocal_gender",
          label: "Vocals",
          type: "select",
          default: "any",
          options: [{ value: "any", label: "Any" }, { value: "f", label: "Female" }, { value: "m", label: "Male" }],
          showIf: (s) => sunoCustom(s) && !s.instrumental,
          help: "Makes that voice more likely, not guaranteed.",
        },
        {
          key: "version",
          label: "Suno version",
          type: "select",
          default: "V6",
          advanced: true,
          options: [{ value: "V6", label: "V6" }, { value: "V6_MINI", label: "V6 Mini" }, { value: "V6_WILD", label: "V6 Wild" }],
        },
        { key: "negative_tags", label: "Avoid", type: "text", maxLength: 200, placeholder: "heavy metal, autotune", advanced: true, showIf: sunoCustom },
      ],
    },
    validate: (p) => {
      const custom = setting<string>(p, "mode") !== "describe";
      const len = p.prompt?.length ?? 0;
      if (custom && !setting<boolean>(p, "instrumental") && !p.prompt) return ["Add lyrics, or switch on Instrumental."];
      if (!custom && !p.prompt) return ["Describe the song you want."];
      if (!custom && len > 3000) return ["Song descriptions can be at most 3000 characters."];
      return [];
    },
    // Kie's market API (snake_case). Describe mode must not send length, vocals or weights.
    mapInput: (p) => {
      const custom = setting<string>(p, "mode") !== "describe";
      const instrumental = Boolean(setting<boolean>(p, "instrumental"));
      const vocal = setting<string>(p, "vocal_gender");
      return withExtra(
        p,
        custom
          ? {
              custom_mode: true,
              instrumental,
              model: setting<string>(p, "version"),
              title: setting<string>(p, "title") || "Untitled",
              style: setting<string>(p, "style"),
              lyrics: instrumental ? undefined : p.prompt,
              duration: setting<number>(p, "duration"),
              vocal_gender: !instrumental && vocal && vocal !== "any" ? vocal : undefined,
              negative_tags: setting<string>(p, "negative_tags") || undefined,
            }
          : { custom_mode: false, instrumental, model: setting<string>(p, "version"), prompt: p.prompt, style: setting<string>(p, "style") },
      );
    },
  },
  elevenLabsTts("v3", "eleven_v3", 0.1, "ElevenLabs' most expressive model. Best for ads and character reads; supports [whispers]-style tags."),
  elevenLabsTts("Multilingual v2", "eleven_multilingual_v2", 0.1, "The steady workhorse. Reliable pacing, 29 languages."),
  elevenLabsTts("Flash 2.5", "eleven_flash_v2_5", 0.05, "Half price and fastest. Good for drafts and long scripts."),
  {
    id: "elevenlabs-dialogue",
    provider: "elevenlabs",
    providerModelId: "eleven_v3",
    name: "ElevenLabs Dialogue",
    description: "Multi-voice conversations (Eleven v3). One line per turn as \"Voice: line\", using any voice in your library.",
    category: "audio",
    mediaType: "audio",
    inputTypes: ["text-to-dialogue"],
    requiresPrompt: true,
    pricing: { unit: "per_1k_chars", rates: { default: 0.1 }, note: "Drawn from your ElevenLabs plan allowance." },
    options: {
      promptLabel: "Dialogue",
      promptPlaceholder: "Liam: Wait, are those the pajamas from the ad?\nBella: Every single night since Christmas.",
      fields: [
        {
          key: "stability",
          label: "Delivery",
          type: "select",
          default: "0.5",
          options: [
            { value: "0", label: "Creative", hint: "Most expressive" },
            { value: "0.5", label: "Natural" },
            { value: "1", label: "Robust", hint: "Most consistent" },
          ],
        },
        { key: "language_code", label: "Language code", type: "text", maxLength: 5, placeholder: "en", advanced: true, help: "ISO 639-1. Leave empty to auto-detect." },
      ],
    },
    validate: (p) => {
      const { turns, errors } = parseDialogue(p.prompt, { requireKnownVoice: false });
      if (errors.length) return errors.slice(0, 3);
      // ElevenLabs caps a dialogue request at 2,000 characters of speech.
      return turns.reduce((n, t) => n + t.text.length, 0) > 2000 ? ["Dialogue can be at most 2000 characters of speech."] : [];
    },
  },

  // ── Image ──
  {
    id: "flux-2-pro",
    provider: "kie",
    providerModelId: "flux-2/pro-text-to-image",
    endpoints: { "text-to-image": "flux-2/pro-text-to-image", "image-edit": "flux-2/pro-image-to-image" },
    name: "Flux 2 Pro",
    description: "Black Forest Labs. Photoreal, great skin and product texture.",
    category: "image",
    mediaType: "image",
    inputTypes: ["text-to-image", "image-edit"],
    requiresPrompt: true,
    pricing: { unit: "per_image", rates: { "1K": cr(5), "2K": cr(7) } },
    options: {
      resolutions: ["1K", "2K"],
      defaultResolution: "1K",
      aspectRatios: ["1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9"],
      defaultAspectRatio: "1:1",
      maxImages: 8,
    },
    mapInput: (p, mode) =>
      withExtra(p, {
        prompt: p.prompt,
        aspect_ratio: p.aspect_ratio,
        resolution: p.resolution,
        input_urls: mode === "image-edit" ? p.image_urls : undefined,
      }),
  },
  gptImage25("Flare", "gpt-image-2-5-flare"),
  gptImage25("Sunburst", "gpt-image-2-5-sunburst"),
  {
    id: "gpt-image-2",
    provider: "kie",
    providerModelId: "gpt-image-2-text-to-image",
    endpoints: { "text-to-image": "gpt-image-2-text-to-image", "image-edit": "gpt-image-2-image-to-image" },
    name: "GPT Image 2",
    description: "OpenAI. Strong prompt following and in-image text; edits with up to 16 reference images.",
    category: "image",
    mediaType: "image",
    inputTypes: ["text-to-image", "image-edit"],
    requiresPrompt: true,
    pricing: { unit: "per_image", rates: { "1K": cr(6), "2K": cr(10), "4K": cr(16) } },
    options: {
      resolutions: ["1K", "2K", "4K"],
      defaultResolution: "2K",
      aspectRatios: ["1:1", "4:5", "3:4", "2:3", "9:16", "5:4", "4:3", "3:2", "16:9", "2:1", "1:2", "21:9", "auto"],
      defaultAspectRatio: "1:1",
      maxImages: 16,
    },
    // Kie refuses these combinations at submit.
    validate: (p) => {
      const r = p.resolution;
      const a = p.aspect_ratio;
      if (a === "auto" && r && r !== "1K") return ["GPT Image 2 only supports 1K with aspect ratio \"auto\"."];
      if (r === "2K" && a && ["5:4", "4:5", "3:1", "1:3", "9:21"].includes(a)) return [`GPT Image 2 can't do ${a} at 2K. Use 1K or 4K, or another aspect ratio.`];
      if (r === "4K" && a && ["1:1", "3:1", "1:3", "9:21"].includes(a)) return [`GPT Image 2 can't do ${a} at 4K. Use 2K, or another aspect ratio.`];
      return [];
    },
    mapInput: (p, mode) =>
      withExtra(p, {
        prompt: p.prompt,
        aspect_ratio: p.aspect_ratio,
        resolution: p.resolution,
        input_urls: mode === "image-edit" ? p.image_urls : undefined,
      }),
  },
  {
    id: "seedream-5-pro",
    provider: "kie",
    providerModelId: "seedream/5-pro-text-to-image",
    endpoints: { "text-to-image": "seedream/5-pro-text-to-image", "image-edit": "seedream/5-pro-image-to-image" },
    name: "Seedream 5",
    description: "ByteDance image model. Strong multi-reference editing.",
    category: "image",
    mediaType: "image",
    family: "seedream-5",
    tier: "Pro",
    inputTypes: ["text-to-image", "image-edit"],
    requiresPrompt: true,
    pricing: { unit: "per_image", rates: { "1K": cr(7), "2K": cr(14) }, note: "+0.5 credits per extra input image." },
    options: {
      resolutions: ["1K", "2K"],
      defaultResolution: "2K",
      aspectRatios: ["1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "21:9"],
      defaultAspectRatio: "1:1",
      maxImages: 10,
    },
    mapInput: (p, mode) =>
      withExtra(p, {
        prompt: p.prompt,
        aspect_ratio: p.aspect_ratio,
        quality: p.resolution === "2K" ? "high" : "basic",
        output_format: "png",
        image_urls: mode === "image-edit" ? p.image_urls : undefined,
      }),
  },
  {
    id: "seedream-5-lite",
    provider: "kie",
    providerModelId: "seedream/5-lite-text-to-image",
    endpoints: { "text-to-image": "seedream/5-lite-text-to-image", "image-edit": "seedream/5-lite-image-to-image" },
    name: "Seedream 5",
    description: "ByteDance image model. Strong multi-reference editing.",
    category: "image",
    mediaType: "image",
    family: "seedream-5",
    tier: "Lite",
    inputTypes: ["text-to-image", "image-edit"],
    requiresPrompt: true,
    pricing: { unit: "per_image", rates: { default: cr(5.5) } },
    options: {
      resolutions: ["2K", "3K", "4K"],
      defaultResolution: "2K",
      aspectRatios: ["1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "21:9"],
      defaultAspectRatio: "1:1",
      maxImages: 14,
    },
    mapInput: (p, mode) =>
      withExtra(p, {
        prompt: p.prompt,
        aspect_ratio: p.aspect_ratio,
        quality: p.resolution === "4K" ? "ultra" : p.resolution === "3K" ? "high" : "basic",
        output_format: "png",
        image_urls: mode === "image-edit" ? p.image_urls : undefined,
      }),
  },

  // ── Upscaling ──
  {
    id: "recraft-crisp-upscale",
    provider: "kie",
    providerModelId: "recraft/crisp-upscale",
    name: "Recraft Crisp Upscale",
    description: "Near-free image upscaler. Sharpens generations for hero images.",
    category: "upscale",
    mediaType: "image",
    inputTypes: ["image-upscale"],
    requiresPrompt: false,
    requiresImage: true,
    pricing: { unit: "flat", amount: cr(0.5) },
    options: { maxImages: 1, imageSlotLabels: ["Source image"] },
    mapInput: (p) => withExtra(p, { image: p.image_urls[0] }),
  },
  {
    id: "topaz-image-upscale",
    provider: "kie",
    providerModelId: "topaz/image-upscale",
    name: "Topaz Image Upscale",
    description: "Premium image upscaling for print and large-format assets.",
    category: "upscale",
    mediaType: "image",
    inputTypes: ["image-upscale"],
    requiresPrompt: false,
    requiresImage: true,
    pricing: { unit: "per_image", rates: { "2x": cr(10), "4x": cr(20) }, note: "Kie lists 2K / 4K output prices." },
    options: { resolutions: ["2x", "4x"], defaultResolution: "2x", maxImages: 1, imageSlotLabels: ["Source image"] },
    mapInput: (p) => withExtra(p, { image_url: p.image_urls[0], upscale_factor: p.resolution === "4x" ? "4" : "2" }),
  },
  {
    id: "topaz-video-upscale",
    provider: "kie",
    providerModelId: "topaz/video-upscale",
    name: "Topaz Video Upscale",
    description: "Upscale generated clips with Topaz. Source video up to 50 MB.",
    category: "upscale",
    mediaType: "video",
    inputTypes: ["video-upscale"],
    requiresPrompt: false,
    requiresVideo: true,
    pricing: { unit: "per_second", rates: { "2x": cr(8), "4x": cr(14) }, durationFrom: "source_video" },
    options: { resolutions: ["2x", "4x"], defaultResolution: "2x" },
    mapInput: (p) => withExtra(p, { video_url: p.video_url, upscale_factor: p.resolution === "4x" ? "4" : "2" }),
  },
];

// ─── lookups ────────────────────────────────────────────────────────────────
export const categoryLabels: Record<Category, string> = {
  video: "Video Generation",
  avatar: "Avatar / Talking Head",
  image: "Image Generation",
  audio: "Music & Voice",
  upscale: "Upscaling",
};

export const categoryOrder: Category[] = ["video", "avatar", "image", "audio", "upscale"];

export const providerLabels: Record<Provider | "fal", string> = {
  elevenlabs: "ElevenLabs",
  kie: "Kie.ai",
  google: "Google direct",
  fal: "fal.ai",
};

const byId = new Map(models.map((m) => [m.id, m]));

/** Accepts our id OR a provider model string (e.g. "nano-banana-pro", "kling-3.0/video"). */
export function getModel(idOrEndpoint: string): ModelConfig | undefined {
  return (
    byId.get(idOrEndpoint) ??
    models.find(
      (m) =>
        m.providerModelId === idOrEndpoint ||
        m.fallback?.providerModelId === idOrEndpoint ||
        Object.values(m.endpoints ?? {}).includes(idOrEndpoint),
    )
  );
}

/** Whether this model has a backup that can run these specific params. */
export function canFallback(model: ModelConfig, params: NormalizedParams): boolean {
  return Boolean(model.fallback && (model.fallback.supports?.(params) ?? true));
}

/** The model as it runs on its backup provider (same UI options, different pipe and prices). */
export function fallbackModel(model: ModelConfig): ModelConfig | undefined {
  if (!model.fallback) return undefined;
  return {
    ...model,
    provider: model.fallback.provider,
    providerModelId: model.fallback.providerModelId,
    endpoints: undefined,
    pricing: model.fallback.pricing,
    fallback: undefined,
    mapInput: undefined,
  };
}

export function familyMembers(model: ModelConfig): ModelConfig[] {
  return model.family ? models.filter((m) => m.family === model.family) : [model];
}

/** Picker cards: one per family (default member = first listed), plus standalone models. */
export function pickerEntries(): ModelConfig[] {
  const seen = new Set<string>();
  return models.filter((m) => {
    if (!m.family) return true;
    if (seen.has(m.family)) return false;
    seen.add(m.family);
    return true;
  });
}

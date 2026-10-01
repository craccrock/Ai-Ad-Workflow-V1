/**
 * Shared (client + server) param normalization, validation and cost estimation.
 * The form uses this for the live estimate; the API uses the exact same code to validate.
 */
import { billableCharacters, type FieldSpec, type InputType, type ModelConfig, type NormalizedParams, type SettingValue } from "@/config/models.config";
import type { GenerationParams } from "@/lib/types";

export type ValidationResult = { ok: true; params: NormalizedParams; mode: InputType } | { ok: false; errors: string[] };

const isUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//i.test(v);

/** Legacy/alias inputs → canonical `image_urls`. Accepts `image_url`, `end_image_url`, `image_urls`. */
export function collectImageUrls(p: GenerationParams): string[] {
  const urls = [...(Array.isArray(p.image_urls) ? p.image_urls : [])];
  if (p.image_url && !urls.includes(p.image_url)) urls.unshift(p.image_url);
  if (p.end_image_url && !urls.includes(p.end_image_url)) urls.push(p.end_image_url);
  return urls.filter(Boolean);
}

const list = <T,>(v: T[] | undefined): T[] => (Array.isArray(v) ? v.filter(Boolean) : []);

type RefParams = Pick<NormalizedParams, "start_frame_url" | "reference_image_urls" | "reference_video_urls" | "reference_audio_urls" | "image_urls">;

export function hasReferences(p: Pick<NormalizedParams, "reference_image_urls" | "reference_video_urls" | "reference_audio_urls">) {
  return p.reference_image_urls.length + p.reference_video_urls.length + p.reference_audio_urls.length > 0;
}

export function resolveMode(model: ModelConfig, p: RefParams): InputType {
  const t = model.inputTypes;
  if (t.includes("audio-to-video")) return "audio-to-video";
  if (t.includes("image-upscale")) return "image-upscale";
  if (t.includes("video-upscale")) return "video-upscale";
  if (model.mediaType === "audio") return t[0];
  if (model.mediaType === "video") {
    if (p.start_frame_url && t.includes("image-to-video")) return "image-to-video";
    if (hasReferences(p) && t.includes("reference-to-video")) return "reference-to-video";
    return "text-to-video";
  }
  return p.image_urls.length > 0 && t.includes("image-edit") ? "image-edit" : "text-to-image";
}

/** A field is active when it has no condition or its condition holds for the current settings. */
export function fieldActive(field: FieldSpec, settings: Record<string, SettingValue | undefined>) {
  return field.showIf ? field.showIf(settings) : true;
}

/**
 * The model's settings with defaults filled in and inactive fields dropped. Unknown keys are dropped too
 * (raw provider fields belong in `extra`). Number fields accept numeric strings from API callers.
 */
export function normalizeSettings(model: ModelConfig, raw: GenerationParams["settings"]): Record<string, SettingValue> {
  const fields = model.options.fields ?? [];
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const merged: Record<string, SettingValue | undefined> = {};
  for (const f of fields) {
    let v = input[f.key] ?? f.default;
    if (f.type === "number" && typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) v = Number(v);
    if (typeof v === "string" && f.type !== "textarea") v = v.trim();
    merged[f.key] = v === "" ? undefined : v;
  }
  const out: Record<string, SettingValue> = {};
  for (const f of fields) if (merged[f.key] !== undefined && fieldActive(f, merged)) out[f.key] = merged[f.key]!;
  return out;
}

function validateSettings(model: ModelConfig, raw: GenerationParams["settings"], settings: Record<string, SettingValue>, errors: string[]) {
  const fields = model.options.fields ?? [];
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) errors.push("`settings` must be an object.");
  const known = new Set(fields.map((f) => f.key));
  const unknown = Object.keys(raw && typeof raw === "object" ? raw : {}).filter((k) => !known.has(k));
  if (unknown.length) errors.push(`Unknown setting${unknown.length > 1 ? "s" : ""} for ${model.name}: ${unknown.join(", ")}. See options.fields in list_models.`);
  for (const f of fields) {
    if (!fieldActive(f, settings)) continue;
    const v = settings[f.key];
    if (v === undefined) {
      if (f.required) errors.push(`${f.label} is required (\`settings.${f.key}\`).`);
      continue;
    }
    if (f.type === "toggle" && typeof v !== "boolean") errors.push(`\`settings.${f.key}\` must be true or false.`);
    if (f.type === "number") {
      if (typeof v !== "number" || Number.isNaN(v)) errors.push(`\`settings.${f.key}\` must be a number.`);
      else if ((f.min != null && v < f.min) || (f.max != null && v > f.max)) errors.push(`${f.label} must be between ${f.min} and ${f.max}.`);
    }
    // `optionsFrom` lists (the ElevenLabs voice library) live on the provider, which checks them itself.
    if (f.type === "select" && !f.optionsFrom && !f.options?.some((o) => o.value === String(v))) {
      errors.push(`\`settings.${f.key}\` must be one of: ${f.options?.map((o) => o.value).join(", ")}.`);
    }
    if ((f.type === "text" || f.type === "textarea") && typeof v !== "string") errors.push(`\`settings.${f.key}\` must be text.`);
    if (f.maxLength && typeof v === "string" && v.length > f.maxLength) errors.push(`${f.label} can be at most ${f.maxLength} characters.`);
  }
}

export function applyDefaults(model: ModelConfig, raw: GenerationParams): NormalizedParams {
  const o = model.options;
  const takesFrames = Boolean(o.references?.frames);
  // Video models: start/end frames. `image_url`/`image_urls` are accepted as aliases for older jobs and API callers.
  const legacy = takesFrames ? collectImageUrls(raw) : [];

  return {
    ...raw,
    prompt: raw.prompt?.trim() || undefined,
    settings: normalizeSettings(model, raw.settings),
    image_urls: takesFrames ? [] : collectImageUrls(raw),
    image_url: undefined,
    end_image_url: undefined,
    start_frame_url: takesFrames ? raw.start_frame_url || legacy[0] || undefined : raw.start_frame_url,
    end_frame_url: takesFrames ? raw.end_frame_url || legacy[1] || undefined : raw.end_frame_url,
    reference_image_urls: list(raw.reference_image_urls),
    reference_video_urls: list(raw.reference_video_urls),
    reference_audio_urls: list(raw.reference_audio_urls),
    elements: Array.isArray(raw.elements) ? raw.elements : [],
    duration: o.durations ? (raw.duration ?? o.defaultDuration ?? o.durations[0]) : raw.duration,
    resolution: o.resolutions ? (raw.resolution ?? o.defaultResolution ?? o.resolutions[0]) : undefined,
    aspect_ratio: o.aspectRatios ? (raw.aspect_ratio ?? o.defaultAspectRatio ?? o.aspectRatios[0]) : undefined,
    generate_audio: o.audioToggle ? (raw.generate_audio ?? o.defaultGenerateAudio ?? false) : undefined,
  };
}

function validateReferences(model: ModelConfig, p: NormalizedParams, errors: string[]) {
  const spec = model.options.references;
  const name = model.tier ? `${model.name} ${model.tier}` : model.name;
  const refImages = p.reference_image_urls.length;
  const refVideos = p.reference_video_urls.length;
  const refAudios = p.reference_audio_urls.length;

  const allUrls = [p.start_frame_url, p.end_frame_url, ...p.reference_image_urls, ...p.reference_video_urls, ...p.reference_audio_urls, ...p.elements.flatMap((e) => e.image_urls ?? [])];
  if (allUrls.some((u) => u !== undefined && !isUrl(u))) errors.push("Reference URLs must be http(s) URLs.");

  // Frames
  if (!spec?.frames && (p.start_frame_url || p.end_frame_url)) errors.push(`${name} doesn't take start/end frames.`);
  if (spec?.frames === "start" && p.end_frame_url) errors.push(`${name} takes a start frame only, not an end frame.`);
  if (p.end_frame_url && !p.start_frame_url) errors.push("An end frame needs a start frame too.");

  // Counts
  const count = (n: number, max: number | undefined, label: string) => {
    if (n === 0) return;
    if (!max) errors.push(`${name} doesn't take reference ${label}.`);
    else if (n > max) errors.push(`${name} accepts at most ${max} reference ${label}.`);
  };
  count(refImages, spec?.images?.max, "images");
  count(refVideos, spec?.videos?.max, "videos");
  count(refAudios, spec?.audios?.max, "audio clips");

  if (spec?.framesExclusive && p.start_frame_url && refImages + refVideos + refAudios > 0) {
    errors.push(`${name} can use start/end frames or references, not both in one generation.`);
  }
  if (spec?.slotBudget) {
    const used = refImages + refVideos * spec.slotBudget.videoWeight;
    if (used > spec.slotBudget.max) {
      errors.push(`${name} fits ${spec.slotBudget.max} reference slots; each video uses ${spec.slotBudget.videoWeight} (you're using ${used}).`);
    }
  }
  if (spec?.audios?.requiresVisual && refAudios > 0 && refImages + refVideos === 0) {
    errors.push(`${name} needs a reference image or video alongside reference audio.`);
  }

  // Clip lengths (checked when the caller knows them — the Studio always does)
  const videoSecs = list(p.reference_video_durations);
  const v = spec?.videos;
  if (v && videoSecs.length) {
    if (v.minSeconds && videoSecs.some((d) => d < v.minSeconds!)) errors.push(`Reference videos must be at least ${v.minSeconds}s each.`);
    if (v.maxSeconds && videoSecs.some((d) => d > v.maxSeconds!)) errors.push(`Reference videos must be at most ${v.maxSeconds}s each.`);
    const total = videoSecs.reduce((a, b) => a + b, 0);
    if (v.maxTotalSeconds && total > v.maxTotalSeconds) errors.push(`Reference videos total ${Math.round(total)}s; the limit is ${v.maxTotalSeconds}s.`);
  }
  const audioSecs = list(p.reference_audio_durations);
  const a = spec?.audios;
  if (a?.maxTotalSeconds && audioSecs.length) {
    const total = audioSecs.reduce((x, y) => x + y, 0);
    if (total > a.maxTotalSeconds) errors.push(`Reference audio totals ${Math.round(total)}s; the limit is ${a.maxTotalSeconds}s.`);
  }

  // Kling elements
  const el = spec?.elements;
  if (p.elements.length) {
    if (!el) errors.push(`${name} doesn't take elements.`);
    else {
      if (p.elements.length > el.max) errors.push(`${name} accepts at most ${el.max} elements.`);
      const names = p.elements.map((e) => e.name?.trim() ?? "");
      if (names.some((n) => !/^[A-Za-z0-9_]{1,40}$/.test(n))) errors.push("Element names can only use letters, numbers and underscores.");
      if (new Set(names).size !== names.length) errors.push("Element names must be unique.");
      if (p.elements.some((e) => (e.image_urls?.length ?? 0) < el.minImages || (e.image_urls?.length ?? 0) > el.maxImages)) {
        errors.push(`Each element needs ${el.minImages}–${el.maxImages} images.`);
      }
      if (el.requiresStartFrame && !p.start_frame_url) errors.push("Elements need a start frame too.");
    }
  }
}

export function validateParams(model: ModelConfig, raw: GenerationParams): ValidationResult {
  const p = applyDefaults(model, raw);
  const o = model.options;
  const errors: string[] = [];

  if (model.requiresPrompt !== false && !p.prompt) errors.push("`prompt` is required.");
  const maxPrompt = o.promptMaxLength ?? 8000;
  if (p.prompt && p.prompt.length > maxPrompt) errors.push(`\`prompt\` is too long (max ${maxPrompt} chars).`);
  validateSettings(model, raw.settings, p.settings, errors);

  const maxImages = o.maxImages ?? 0;
  if (p.image_urls.length > maxImages) {
    errors.push(maxImages === 0 ? `${model.name} does not accept images.` : `${model.name} accepts at most ${maxImages} image(s).`);
  }
  if (p.image_urls.some((u) => !isUrl(u))) errors.push("Image URLs must be http(s) URLs.");
  if (model.requiresImage && p.image_urls.length === 0) errors.push(`${model.name} requires an image (\`image_url\`).`);

  if (model.requiresAudio && !isUrl(p.audio_url)) errors.push(`${model.name} requires an audio file (\`audio_url\`).`);
  if (model.requiresVideo && !isUrl(p.video_url)) errors.push(`${model.name} requires a video (\`video_url\`).`);

  const frames = o.references?.frames;
  if (frames) {
    // Legacy `image_urls` on a video model means [start, end] — anything beyond that would be silently dropped.
    const legacyCount = collectImageUrls(raw).length;
    const maxFrames = frames === "start-end" ? 2 : 1;
    if (legacyCount > maxFrames) {
      errors.push(`${model.name} takes ${maxFrames === 2 ? "a start and end frame" : "one start frame"} — use \`reference_image_urls\` for references.`);
    }
  }

  validateReferences(model, p, errors);

  if (o.durations && p.duration != null && !o.durations.includes(Number(p.duration))) {
    errors.push(`\`duration\` must be one of: ${o.durations.join(", ")}.`);
  }
  if (o.resolutions && p.resolution && !o.resolutions.includes(p.resolution)) {
    errors.push(`\`resolution\` must be one of: ${o.resolutions.join(", ")}.`);
  }
  if (o.aspectRatios && p.aspect_ratio && !o.aspectRatios.includes(p.aspect_ratio)) {
    errors.push(`\`aspect_ratio\` must be one of: ${o.aspectRatios.join(", ")}.`);
  }
  if (p.extra != null && (typeof p.extra !== "object" || Array.isArray(p.extra))) errors.push("`extra` must be an object.");
  if (model.validate) errors.push(...model.validate(p));

  if (errors.length) return { ok: false, errors };
  return { ok: true, params: { ...p, duration: p.duration != null ? Number(p.duration) : undefined }, mode: resolveMode(model, p) };
}

// ─── cost ───────────────────────────────────────────────────────────────────

export type CostEstimate = {
  perGeneration: number | null;
  total: number | null;
  /** Human explanation, e.g. "8s × $0.101/s at 720p". */
  basis: string;
  /** True when a required input (e.g. audio length) is unknown. */
  incomplete?: boolean;
};

function rateFor(rates: Record<string, number>, key?: string) {
  if (key && rates[key] != null) return rates[key];
  return rates.default ?? Object.values(rates)[0];
}

export function estimateCost(
  model: ModelConfig,
  params: Partial<NormalizedParams>,
  variants = 1,
  ctx: { sourceVideoSeconds?: number } = {},
): CostEstimate {
  const pr = model.pricing;
  const n = Math.max(1, variants);

  if (pr.unit === "flat") {
    return { perGeneration: pr.amount, total: pr.amount * n, basis: `~$${pr.amount} per run` };
  }

  if (pr.unit === "per_1k_chars") {
    const rate = rateFor(pr.rates);
    const chars = billableCharacters(model, params.prompt);
    if (!chars) return { perGeneration: null, total: null, basis: `$${rate} per 1,000 characters`, incomplete: true };
    const per = Math.round(((chars / 1000) * rate) * 10000) / 10000;
    return { perGeneration: per, total: per * n, basis: `${chars.toLocaleString("en-US")} characters × $${rate} per 1,000` };
  }

  const withVideoInput = (params.reference_video_urls?.length ?? 0) > 0;

  if (pr.unit === "per_video") {
    const res = params.resolution ?? "*";
    const dur = params.duration != null ? String(params.duration) : "*";
    if (withVideoInput && pr.videoInputRates) {
      const rate = pr.videoInputRates[res] ?? pr.videoInputRates["*"];
      return { perGeneration: rate, total: rate * n, basis: `$${rate} per clip with a reference video${params.resolution ? ` at ${params.resolution}` : ""}` };
    }
    const rate = pr.rates[`${res}|${dur}`] ?? pr.rates[`*|${dur}`] ?? pr.rates[`${res}|*`] ?? pr.rates["*|*"];
    if (rate == null) return { perGeneration: null, total: null, basis: "No price for these settings", incomplete: true };
    const length = params.duration ? `${params.duration}s ` : "";
    const at = params.resolution ? ` at ${params.resolution}` : "";
    return { perGeneration: rate, total: rate * n, basis: `$${rate} per ${length}clip${at}` };
  }

  if (pr.unit === "per_image") {
    const rate = rateFor(pr.rates, params.resolution);
    const label = params.resolution ? ` at ${params.resolution}` : "";
    return { perGeneration: rate, total: rate * n, basis: `$${rate} per image${label}` };
  }

  // per_second
  const useVideoInput = withVideoInput && Boolean(pr.videoInputRates);
  const useAudio = !useVideoInput && Boolean(params.generate_audio && pr.audioRates);
  const table = useVideoInput ? pr.videoInputRates! : useAudio && pr.audioRates ? pr.audioRates : pr.rates;
  const rate = rateFor(table, params.resolution);
  const inputImages = [params.start_frame_url, params.end_frame_url].filter(Boolean).length + (params.reference_image_urls?.length ?? 0);
  const imageExtra = pr.perInputImage ? pr.perInputImage * inputImages : 0;
  let seconds: number | undefined;
  let secondsLabel = "s";
  if (pr.durationFrom === "audio") {
    seconds = params.audio_duration_seconds;
    secondsLabel = "s of audio";
  } else if (pr.durationFrom === "source_video") {
    seconds = ctx.sourceVideoSeconds;
    secondsLabel = "s of video";
  } else {
    seconds = params.duration;
  }

  const resLabel = params.resolution ? ` at ${params.resolution}` : "";
  const modeLabel = useVideoInput ? " with reference video" : useAudio ? " with audio" : "";
  const imageLabel = imageExtra ? ` + ${inputImages} image${inputImages === 1 ? "" : "s"} × $${pr.perInputImage}` : "";
  if (seconds == null || Number.isNaN(seconds)) {
    return { perGeneration: null, total: null, basis: `$${rate}/s${resLabel}${modeLabel}`, incomplete: true };
  }
  const per = Math.ceil(seconds) * rate + imageExtra;
  return {
    perGeneration: per,
    total: per * n,
    basis: `${Math.ceil(seconds)}${secondsLabel} × $${rate}/s${resLabel}${modeLabel}${imageLabel}`,
  };
}

/**
 * Real cost once the provider reports usage. Kie: credits consumed × $/credit.
 * Google: video output tokens × token rate. Otherwise output duration × rate, else the estimate.
 */
export function actualCost(
  model: ModelConfig,
  params: NormalizedParams,
  usage: { costUsd?: number; videoOutputTokens?: number; outputDurationSeconds?: number },
  estimate: number | null,
): number | null {
  if (usage.costUsd != null && usage.costUsd >= 0) return usage.costUsd;
  const pr = model.pricing;
  if (pr.unit === "per_second") {
    if (usage.videoOutputTokens && pr.videoOutputTokenRatePerMillion) {
      return (usage.videoOutputTokens * pr.videoOutputTokenRatePerMillion) / 1_000_000;
    }
    if (usage.outputDurationSeconds && pr.durationFrom !== "source_video") {
      const useAudio = Boolean(params.generate_audio && pr.audioRates);
      const rate = rateFor(useAudio && pr.audioRates ? pr.audioRates : pr.rates, params.resolution);
      return Math.ceil(usage.outputDurationSeconds) * rate;
    }
  }
  return estimate;
}

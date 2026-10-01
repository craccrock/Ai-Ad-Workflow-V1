import { categoryLabels, models } from "@/config/models.config";

/** The model catalog for API and MCP clients (Claude). Mirrors models.config.ts. */
export function modelCatalog() {
  return {
    models: models.map((m) => ({
      id: m.id,
      name: m.tier ? `${m.name} ${m.tier}` : m.name,
      description: m.description,
      category: m.category,
      category_label: categoryLabels[m.category],
      media_type: m.mediaType,
      provider: m.provider,
      provider_model_id: m.providerModelId,
      endpoints: m.endpoints,
      fallback: m.fallback ? { provider: m.fallback.provider, provider_model_id: m.fallback.providerModelId, pricing: m.fallback.pricing } : null,
      input_types: m.inputTypes,
      requires: {
        prompt: m.requiresPrompt !== false,
        image: Boolean(m.requiresImage),
        audio: Boolean(m.requiresAudio),
        video: Boolean(m.requiresVideo),
      },
      options: { ...m.options, fields: m.options.fields?.map(({ showIf, ...f }) => ({ ...f, conditional: showIf ? true : undefined })) },
      pricing: m.pricing,
    })),
    params_reference: {
      prompt: "string",
      image_urls: "string[] — image models: reference images; avatars/upscalers: the source image (image_url also accepted)",
      start_frame_url: "string — video models with options.references.frames",
      end_frame_url: "string — needs start_frame_url; only when references.frames is 'start-end'",
      reference_image_urls: "string[] — up to options.references.images.max",
      reference_video_urls: "string[] — up to options.references.videos.max",
      reference_video_durations: "number[] — seconds per reference video, same order; enables length checks and Omni trimming",
      reference_audio_urls: "string[] — up to options.references.audios.max",
      reference_audio_durations: "number[] — seconds per reference audio clip",
      elements: "{ name, description?, image_urls[] }[] — Kling 3.0 only; write @name in the prompt; needs start_frame_url",
      audio_url: "string — required by avatar models",
      audio_duration_seconds: "number — lets the estimate price avatar jobs before they run",
      video_url: "string — required by video upscalers",
      rules: "When options.references.framesExclusive is true, send frames OR references, not both. Reference videos change the price on Seedance and Omni.",
      aspect_ratio: "string — one of options.aspectRatios",
      duration: "number — one of options.durations",
      resolution: "string — one of options.resolutions",
      generate_audio: "boolean — when options.audioToggle",
      negative_prompt: "string — when options.supportsNegativePrompt",
      seed: "number — when options.supportsSeed",
      settings:
        "object — model-specific settings listed in options.fields (key, type, options, default, min/max). Suno: { mode: custom|describe, style, title, duration (10–360s, custom mode), instrumental, vocal_gender, version }; prompt = lyrics (custom) or a description (describe). ElevenLabs Voice: { voice (id from the field's options), speed, stability, … }; prompt = the script. ElevenLabs Dialogue: prompt is one line per turn, \"Voice name: line\".",
      song_outputs: "Suno returns 2 takes per job: result_url and result_metadata.additional_files[0]; result_metadata.provider.tracks lists audio_id and duration per take. get_song_timing gives lyric timestamps.",
      extra: "object — raw Kie input fields merged into the request last (not applied on the Google backup)",
    },
  };
}

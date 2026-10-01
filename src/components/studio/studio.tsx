"use client";

import { ChevronRight, Loader2, Sparkles } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { familyMembers, getModel, models, providerLabels, type ModelConfig } from "@/config/models.config";
import { api, type ApiGeneration, type ApiMedia } from "@/lib/client-api";
import { estimateCost, validateParams } from "@/lib/generation-params";
import type { GenerationParams, Profile } from "@/lib/types";
import { cn, formatUsd } from "@/lib/utils";
import type { TypicalDurations } from "@/lib/job-status";
import { Gallery, type GalleryHandle } from "./gallery";
import { MediaInput, refFromMedia, type MediaRef } from "./media-input";
import { ModelPicker } from "./model-picker";
import { activeReferenceModes, ReferenceInputs, type ReferenceState } from "./reference-inputs";
import { reconcileSettings, SettingsFields, settingsForRequest, type Settings, type VoiceOption } from "./settings-fields";

type FormState = ReferenceState & {
  modelId: string;
  prompt: string;
  negativePrompt: string;
  /** Image models, avatar face, upscaler source. */
  images: MediaRef[];
  audio: MediaRef[];
  video: MediaRef[];
  aspectRatio?: string;
  duration?: number;
  resolution?: string;
  generateAudio: boolean;
  /** Model-specific settings (options.fields). */
  settings: Settings;
  variants: number;
  seed: string;
  isShared: boolean;
};

const DEFAULT_MODEL = "nano-banana-pro";

/** Keep what still applies when switching models; fall back to the new model's defaults otherwise. */
function reconcile(state: FormState, model: ModelConfig, voices?: VoiceOption[]): FormState {
  const o = model.options;
  const keep = <T,>(v: T | undefined, allowed: T[] | undefined, fallback: T | undefined) => (allowed ? (v !== undefined && allowed.includes(v) ? v : fallback ?? allowed[0]) : undefined);
  const r = o.references;
  const takesRefs = Boolean(r && (r.images || r.videos || r.audios));
  return {
    ...state,
    modelId: model.id,
    images: state.images.slice(0, o.maxImages ?? 0),
    frames: r?.frames ? state.frames.slice(0, r.frames === "start-end" ? 2 : 1) : [],
    refImages: state.refImages.slice(0, r?.images?.max ?? 0),
    refVideos: state.refVideos.slice(0, r?.videos?.max ?? 0),
    refAudios: state.refAudios.slice(0, r?.audios?.max ?? 0),
    elements: r?.elements ? state.elements.slice(0, r.elements.max).map((e) => ({ ...e, images: e.images.slice(0, r.elements!.maxImages) })) : [],
    refMode: !r?.frames && takesRefs ? "references" : r?.frames && !takesRefs ? "frames" : state.refMode,
    aspectRatio: keep(state.aspectRatio, o.aspectRatios, o.defaultAspectRatio),
    duration: keep(state.duration, o.durations, o.defaultDuration),
    resolution: keep(state.resolution, o.resolutions, o.defaultResolution),
    generateAudio: o.audioToggle ? state.generateAudio : false,
    settings: reconcileSettings(state.settings, model, voices),
  };
}

function initialState(): FormState {
  const model = getModel(DEFAULT_MODEL) ?? models[0];
  return reconcile(
    {
      modelId: model.id,
      prompt: "",
      negativePrompt: "",
      images: [],
      audio: [],
      video: [],
      frames: [],
      refImages: [],
      refVideos: [],
      refAudios: [],
      elements: [],
      refMode: "frames",
      generateAudio: model.options.defaultGenerateAudio ?? false,
      settings: {},
      variants: 1,
      seed: "",
      isShared: true,
    },
    model,
  );
}

const durations = (refs: MediaRef[]) => (refs.length && refs.every((r) => r.durationSeconds != null) ? refs.map((r) => r.durationSeconds!) : undefined);

function toParams(s: FormState, model: ModelConfig): GenerationParams {
  const { useFrames, useRefs } = activeReferenceModes(model, s.refMode);
  return {
    prompt: s.prompt,
    negative_prompt: s.negativePrompt || undefined,
    image_urls: s.images.map((i) => i.url),
    start_frame_url: useFrames ? s.frames[0]?.url : undefined,
    end_frame_url: useFrames ? s.frames[1]?.url : undefined,
    reference_image_urls: useRefs ? s.refImages.map((r) => r.url) : undefined,
    reference_video_urls: useRefs ? s.refVideos.map((r) => r.url) : undefined,
    reference_video_durations: useRefs ? durations(s.refVideos) : undefined,
    reference_audio_urls: useRefs ? s.refAudios.map((r) => r.url) : undefined,
    reference_audio_durations: useRefs ? durations(s.refAudios) : undefined,
    elements: useFrames && s.elements.length ? s.elements.map((e) => ({ name: e.name, image_urls: e.images.map((i) => i.url) })) : undefined,
    audio_url: s.audio[0]?.url,
    audio_duration_seconds: s.audio[0]?.durationSeconds,
    video_url: s.video[0]?.url,
    source_video_duration_seconds: s.video[0]?.durationSeconds,
    aspect_ratio: s.aspectRatio,
    duration: s.duration,
    resolution: s.resolution,
    generate_audio: s.generateAudio || undefined,
    seed: s.seed ? Number(s.seed) : undefined,
    settings: settingsForRequest(s.settings, model),
  };
}

export function Studio({
  profile,
  team,
  typicalDurations,
  retentionDays,
  voices,
}: {
  profile: Profile;
  team: Pick<Profile, "id" | "display_name">[];
  typicalDurations?: TypicalDurations;
  retentionDays?: number | null;
  /** ElevenLabs voices from the account, for the voice picker. */
  voices?: VoiceOption[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [state, setState] = useState<FormState>(initialState);
  const [submitting, setSubmitting] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const galleryRef = useRef<GalleryHandle>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const model = getModel(state.modelId) ?? models[0];
  const o = model.options;
  const tiers = familyMembers(model);
  const params = toParams(state, model);
  const validation = validateParams(model, params);
  const estimate = estimateCost(model, validation.ok ? validation.params : params, state.variants, { sourceVideoSeconds: state.video[0]?.durationSeconds });

  const update = (patch: Partial<FormState>) => setState((s) => ({ ...s, ...patch }));
  const selectModel = (m: ModelConfig) => setState((s) => reconcile(s, m, voices));

  // "Use in generation" from the Media Library → /?use=<mediaId>
  useEffect(() => {
    const id = searchParams.get("use");
    if (!id) return;
    api<ApiMedia>(`/api/media/${id}`)
      .then((m) => {
        const ref = refFromMedia(m);
        setState((s) => {
          const current = getModel(s.modelId)!;
          const r = current.options.references;
          if (m.type === "audio") {
            if (r?.audios && s.refAudios.length < r.audios.max) return { ...s, refMode: "references", refAudios: [...s.refAudios, ref] };
            return { ...reconcile(s, getModel("kling-avatar-standard")!, voices), audio: [ref] };
          }
          if (m.type === "video") {
            if (r?.videos && s.refVideos.length < r.videos.max) return { ...s, refMode: "references", refVideos: [...s.refVideos, ref] };
            return { ...reconcile(s, getModel("topaz-video-upscale")!, voices), video: [ref] };
          }
          // Images: a reference if the form is in references mode, otherwise the next free frame.
          if (r?.images && s.refMode === "references" && s.refImages.length < r.images.max) return { ...s, refImages: [...s.refImages, ref] };
          const frameSlots = r?.frames === "start-end" ? 2 : r?.frames ? 1 : 0;
          if (frameSlots && s.frames.length < frameSlots) return { ...s, refMode: "frames", frames: [...s.frames, ref] };
          const target = (current.options.maxImages ?? 0) > s.images.length ? current : getModel("nano-banana-pro")!;
          const next = reconcile(s, target, voices);
          return { ...next, images: [...next.images, ref].slice(0, target.options.maxImages ?? 1) };
        });
        toast.success("Added to the form", { description: m.filename });
      })
      .catch((e) => toast.error(e.message))
      .finally(() => router.replace("/", { scroll: false }));
    // `voices` only affects reconcile defaults; re-running this effect when it loads isn't wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, router]);

  async function submit(overrides?: { model: string; params: Record<string, unknown>; variants?: number }) {
      if (submitting) return;
      if (!overrides && !validation.ok) {
        toast.error("Can't generate yet", { description: validation.errors.join(" ") });
        return;
      }
      setSubmitting(true);
      try {
        const res = await api<{ jobs: ApiGeneration[] }>("/api/generate", {
          method: "POST",
          json: overrides
            ? { model: overrides.model, params: overrides.params, variants: overrides.variants ?? 1, is_shared: state.isShared }
            : { model: model.id, params, variants: state.variants, is_shared: state.isShared },
        });
        galleryRef.current?.prepend(res.jobs.map((j) => ({ ...j, user: { id: profile.id, display_name: profile.display_name, avatar_url: profile.avatar_url, is_bot: false } })));
      } catch (e) {
        toast.error("Generation failed to start", { description: e instanceof Error ? e.message : String(e) });
      } finally {
        setSubmitting(false);
      }
  }

  // ⌘/Ctrl + Enter to generate (ref keeps the listener stable while seeing the latest form state)
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void submitRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function loadSettings(g: ApiGeneration) {
    const m = getModel(g.model);
    if (!m) {
      toast.error("That model is no longer in the config");
      return;
    }
    const p = g.params as GenerationParams;
    const takesFrames = Boolean(m.options.references?.frames);
    const start = p.start_frame_url ?? (takesFrames ? p.image_urls?.[0] : undefined);
    const end = p.end_frame_url ?? (takesFrames ? p.image_urls?.[1] : undefined);
    const refs = (urls: string[] | undefined, label: string, secs?: number[]) =>
      (urls ?? []).map((url, i) => ({ url, name: `${label} ${i + 1}`, durationSeconds: secs?.[i] }));
    const refImages = refs(p.reference_image_urls, "Reference image");
    const refVideos = refs(p.reference_video_urls, "Reference video", p.reference_video_durations);
    const refAudios = refs(p.reference_audio_urls, "Reference audio", p.reference_audio_durations);
    setState((s) => ({
      ...reconcile(s, m, voices),
      prompt: p.prompt ?? "",
      negativePrompt: p.negative_prompt ?? "",
      images: takesFrames ? [] : (p.image_urls ?? []).map((url, i) => ({ url, name: `Reference ${i + 1}` })),
      frames: [start, end].filter((u): u is string => Boolean(u)).map((url, i) => ({ url, name: i === 0 ? "Start frame" : "End frame" })),
      refImages,
      refVideos,
      refAudios,
      elements: (p.elements ?? []).map((e, i) => ({ key: `${i}-${e.name}`, name: e.name, images: refs(e.image_urls, e.name) })),
      refMode: refImages.length + refVideos.length + refAudios.length > 0 ? "references" : "frames",
      audio: p.audio_url ? [{ url: p.audio_url, name: "Audio", durationSeconds: p.audio_duration_seconds }] : [],
      video: p.video_url ? [{ url: p.video_url, name: "Video", durationSeconds: p.source_video_duration_seconds }] : [],
      aspectRatio: p.aspect_ratio ?? s.aspectRatio,
      duration: p.duration ?? s.duration,
      resolution: p.resolution ?? s.resolution,
      generateAudio: Boolean(p.generate_audio),
      settings: reconcileSettings({ ...p.settings }, m, voices),
      seed: p.seed != null ? String(p.seed) : "",
    }));
    window.scrollTo({ top: 0, behavior: "smooth" });
    setTimeout(() => promptRef.current?.focus(), 300);
    toast.success("Settings loaded", { description: g.model_display_name });
  }

  const rerun = (g: ApiGeneration) => void submit({ model: g.model, params: g.params as Record<string, unknown> });

  const maxImages = o.maxImages ?? 0;

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(360px,420px)_minmax(0,1fr)] lg:gap-10">
      {/* ── Generation form ── */}
      <div className="min-w-0 lg:sticky lg:top-[88px] lg:max-h-[calc(100vh-104px)] lg:self-start lg:overflow-y-auto lg:pr-1">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-5"
        >
          <ModelPicker value={model} onChange={selectModel} />

          {tiers.length > 1 ? (
            <div className="space-y-2">
              <Label>Quality tier</Label>
              <Segmented
                aria-label="Quality tier"
                value={model.id}
                options={tiers.map((t) => ({ value: t.id, label: t.tier }))}
                onChange={(id) => selectModel(getModel(id)!)}
              />
            </div>
          ) : null}

          {model.category !== "upscale" ? (
          <div className="space-y-2">
            <Label htmlFor="prompt">
              {o.promptLabel ?? "Prompt"} {model.requiresPrompt === false ? <span className="normal-case tracking-normal text-muted">(optional)</span> : null}
            </Label>
            <Textarea
              id="prompt"
              ref={promptRef}
              rows={model.mediaType === "audio" ? 8 : 5}
              value={state.prompt}
              onChange={(e) => update({ prompt: e.target.value })}
              placeholder={o.promptPlaceholder ?? (model.mediaType === "video" ? "Describe the shot, subject, motion and camera…" : "Describe the image…")}
            />
          </div>
          ) : null}

          {maxImages > 0 ? (
            <MediaInput
              type="image"
              userId={profile.id}
              label={model.requiresImage ? (o.imageSlotLabels?.[0] ?? "Image") : `Reference images (optional, up to ${maxImages})`}
              value={state.images}
              onChange={(images) => update({ images })}
              slots={maxImages}
              slotLabels={o.imageSlotLabels}
            />
          ) : null}

          <SettingsFields model={model} value={state.settings} onChange={(settings) => update({ settings })} voices={voices} />

          <ReferenceInputs model={model} userId={profile.id} value={state} onChange={update} />

          {model.requiresAudio ? (
            <MediaInput type="audio" userId={profile.id} label="Audio" value={state.audio} onChange={(audio) => update({ audio })} />
          ) : null}

          {model.requiresVideo ? (
            <MediaInput type="video" userId={profile.id} label="Source video" value={state.video} onChange={(video) => update({ video })} />
          ) : null}

          {o.aspectRatios && !(o.aspectRatioTextOnly && params.start_frame_url) ? (
            <div className="space-y-2">
              <Label>Aspect ratio</Label>
              <Segmented aria-label="Aspect ratio" value={state.aspectRatio} options={o.aspectRatios.map((v) => ({ value: v }))} onChange={(aspectRatio) => update({ aspectRatio })} />
            </div>
          ) : null}

          {o.durations ? (
            <div className="space-y-2">
              <Label>Duration</Label>
              <Segmented aria-label="Duration" value={state.duration} options={o.durations.map((v) => ({ value: v, label: `${v}s` }))} onChange={(duration) => update({ duration })} />
            </div>
          ) : null}

          {o.resolutions && o.resolutions.length > 1 ? (
            <div className="space-y-2">
              <Label>{model.category === "upscale" ? "Scale" : "Resolution"}</Label>
              <Segmented aria-label="Resolution" value={state.resolution} options={o.resolutions.map((v) => ({ value: v }))} onChange={(resolution) => update({ resolution })} />
            </div>
          ) : null}

          <div className="flex flex-wrap items-end gap-x-8 gap-y-5">
            <div className="space-y-2">
              <Label>Variants</Label>
              <Segmented aria-label="Number of variants" value={state.variants} options={[1, 2, 3, 4].map((v) => ({ value: v }))} onChange={(variants) => update({ variants })} />
            </div>
            {o.audioToggle ? (
              <label className="flex cursor-pointer items-center gap-2.5 pb-1.5 text-sm text-cream-2">
                <input type="checkbox" className="size-4 accent-[var(--gold)]" checked={state.generateAudio} onChange={(e) => update({ generateAudio: e.target.checked })} />
                Generate audio
              </label>
            ) : null}
          </div>

          <div className="border-t border-hairline pt-3">
            <button type="button" onClick={() => setAdvancedOpen((v) => !v)} className="flex items-center gap-1.5 text-xs uppercase tracking-[0.08em] text-cream-2 hover:text-cream">
              <ChevronRight className={cn("size-3.5 transition-transform", advancedOpen && "rotate-90")} /> Advanced
            </button>
            {advancedOpen ? (
              <div className="mt-4 space-y-4">
                <SettingsFields model={model} value={state.settings} onChange={(settings) => update({ settings })} advanced voices={voices} />
                {o.supportsNegativePrompt ? (
                  <div className="space-y-2">
                    <Label htmlFor="neg">Negative prompt</Label>
                    <Input id="neg" value={state.negativePrompt} onChange={(e) => update({ negativePrompt: e.target.value })} placeholder="blur, distortion, low quality" />
                  </div>
                ) : null}
                {o.supportsSeed ? (
                  <div className="space-y-2">
                    <Label htmlFor="seed">Seed</Label>
                    <Input id="seed" inputMode="numeric" value={state.seed} onChange={(e) => update({ seed: e.target.value.replace(/\D/g, "") })} placeholder="Random" className="font-mono" />
                  </div>
                ) : null}
                <label className="flex cursor-pointer items-center gap-2.5 text-sm text-cream-2">
                  <input type="checkbox" className="size-4 accent-[var(--gold)]" checked={state.isShared} onChange={(e) => update({ isShared: e.target.checked })} />
                  Share with the team
                </label>
                <p className="font-mono text-[11px] text-muted">
                  Routed via {providerLabels[model.provider]} · {model.endpoints?.[validation.ok ? validation.mode : model.inputTypes[0]] ?? model.providerModelId}
                  {model.fallback ? ` · backup: ${providerLabels[model.fallback.provider]}` : ""}
                </p>
              </div>
            ) : null}
          </div>

          {/* ── Cost + CTA ── */}
          <div className="rounded-[8px] border border-hairline bg-surface p-4">
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <div className="font-mono text-2xl text-cream">
                  {estimate.total != null ? (
                    <>
                      {formatUsd(estimate.total)} <span className="text-sm text-cream-2">estimated</span>
                    </>
                  ) : (
                    <span className="text-base text-cream-2">{model.requiresAudio ? "Add audio to estimate" : model.requiresVideo ? "Add a video to estimate" : model.pricing.unit === "per_1k_chars" ? "Write the script to estimate" : "—"}</span>
                  )}
                </div>
                <div className="mt-1 font-mono text-[11px] text-muted">
                  {estimate.basis}
                  {state.variants > 1 && estimate.perGeneration != null ? ` × ${state.variants} variants` : ""}
                </div>
              </div>
            </div>
            {!validation.ok && (state.prompt || state.images.length || state.audio.length) ? (
              <p className="mt-2 text-xs text-cream-2">{validation.errors[0]}</p>
            ) : null}
            <Button type="submit" variant="gold" size="lg" className="mt-4 w-full" disabled={submitting || !validation.ok}>
              {submitting ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {submitting ? "Starting…" : state.variants > 1 ? `Generate ${state.variants}` : "Generate"}
              <kbd className="ml-auto hidden rounded border border-navy/25 px-1.5 font-mono text-[10px] sm:inline">⌘ ↵</kbd>
            </Button>
          </div>
        </form>
      </div>

      {/* ── Results ── */}
      <Gallery ref={galleryRef} currentUser={profile} team={team} typicalDurations={typicalDurations} retentionDays={retentionDays} onRerun={rerun} onUseSettings={loadSettings} />
    </div>
  );
}

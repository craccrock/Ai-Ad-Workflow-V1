"use client";

import { Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import type { ModelConfig } from "@/config/models.config";
import { MediaInput, type MediaRef } from "./media-input";

export type ElementDraft = { key: string; name: string; images: MediaRef[] };

export type ReferenceState = {
  frames: MediaRef[];
  refImages: MediaRef[];
  refVideos: MediaRef[];
  refAudios: MediaRef[];
  elements: ElementDraft[];
  refMode: "frames" | "references";
};

const seconds = (refs: MediaRef[]) => refs.reduce((sum, r) => sum + (r.durationSeconds ?? 0), 0);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Which inputs a model shows, given its spec and the frames/references toggle. */
export function activeReferenceModes(model: ModelConfig, refMode: ReferenceState["refMode"]) {
  const spec = model.options.references;
  const takesRefs = Boolean(spec && (spec.images || spec.videos || spec.audios));
  const exclusive = Boolean(spec?.frames && takesRefs && spec.framesExclusive);
  return {
    showToggle: exclusive,
    useFrames: Boolean(spec?.frames) && (!exclusive || refMode === "frames"),
    useRefs: takesRefs && (!exclusive || refMode === "references"),
  };
}

export function ReferenceInputs({
  model,
  userId,
  value,
  onChange,
}: {
  model: ModelConfig;
  userId: string;
  value: ReferenceState;
  onChange: (patch: Partial<ReferenceState>) => void;
}) {
  const spec = model.options.references;
  if (!spec) return null;
  const { showToggle, useFrames, useRefs } = activeReferenceModes(model, value.refMode);

  const videoSecs = seconds(value.refVideos);
  const audioSecs = seconds(value.refAudios);
  const slotsUsed = spec.slotBudget ? value.refImages.length + value.refVideos.length * spec.slotBudget.videoWeight : 0;
  const imageSlots = spec.images ? Math.min(spec.images.max, spec.slotBudget ? spec.slotBudget.max - value.refVideos.length * spec.slotBudget.videoWeight : spec.images.max) : 0;
  const videoSlots = spec.videos
    ? Math.min(spec.videos.max, spec.slotBudget ? Math.max(value.refVideos.length, Math.floor((spec.slotBudget.max - value.refImages.length) / spec.slotBudget.videoWeight)) : spec.videos.max)
    : 0;

  return (
    <div className="space-y-4">
      {showToggle ? (
        <div className="space-y-2">
          <span className="text-xs font-medium uppercase tracking-[0.08em] text-cream-2">Guide the video with</span>
          <Segmented
            aria-label="Frames or references"
            value={value.refMode}
            onChange={(refMode) => onChange({ refMode })}
            options={[
              { value: "frames", label: spec.frames === "start-end" ? "Start / end frame" : "Start frame" },
              { value: "references", label: "References" },
            ]}
          />
          <p className="text-[11px] text-muted">
            {value.refMode === "frames"
              ? "Pin exactly how the clip starts (and optionally ends)."
              : "Show the model characters, products, styles or motion to draw from. Mention them in your prompt."}
          </p>
        </div>
      ) : null}

      {useFrames && spec.frames ? (
        <MediaInput
          type="image"
          userId={userId}
          label={spec.frames === "start-end" ? "Start / end frame (optional)" : "Start frame (optional)"}
          value={value.frames}
          onChange={(frames) => onChange({ frames })}
          slots={spec.frames === "start-end" ? 2 : 1}
          slotLabels={["Start frame", "End frame"]}
        />
      ) : null}

      {useRefs && spec.images ? (
        <MediaInput
          type="image"
          userId={userId}
          label="Reference images"
          hint={
            spec.slotBudget
              ? `${slotsUsed} of ${spec.slotBudget.max} reference slots used — a video takes ${spec.slotBudget.videoWeight}`
              : `Up to ${spec.images.max}`
          }
          value={value.refImages}
          onChange={(refImages) => onChange({ refImages })}
          slots={Math.max(imageSlots, value.refImages.length)}
        />
      ) : null}

      {useRefs && spec.videos ? (
        <MediaInput
          type="video"
          userId={userId}
          label="Reference videos"
          hint={[
            `Up to ${plural(spec.videos.max, "clip")}`,
            spec.videos.minSeconds && spec.videos.maxSeconds
              ? `${spec.videos.minSeconds}–${spec.videos.maxSeconds}s each`
              : spec.videos.maxSeconds
                ? `up to ${spec.videos.maxSeconds}s each`
                : "",
            spec.videos.maxTotalSeconds ? `${Math.round(videoSecs)} of ${spec.videos.maxTotalSeconds}s used` : "",
            model.pricing.unit !== "flat" && "videoInputRates" in model.pricing && model.pricing.videoInputRates ? "changes the price" : "",
          ]
            .filter(Boolean)
            .join(" · ")}
          value={value.refVideos}
          onChange={(refVideos) => onChange({ refVideos })}
          slots={Math.max(videoSlots, value.refVideos.length)}
        />
      ) : null}

      {useRefs && spec.audios ? (
        <MediaInput
          type="audio"
          userId={userId}
          label="Reference audio"
          hint={[
            `Up to ${plural(spec.audios.max, "clip")}`,
            spec.audios.maxTotalSeconds ? `${Math.round(audioSecs)} of ${spec.audios.maxTotalSeconds}s used` : "",
            spec.audios.requiresVisual ? "needs a reference image or video too" : "",
          ]
            .filter(Boolean)
            .join(" · ")}
          value={value.refAudios}
          onChange={(refAudios) => onChange({ refAudios })}
          slots={spec.audios.max}
        />
      ) : null}

      {useFrames && spec.elements ? (
        <ElementsEditor spec={spec.elements} userId={userId} value={value.elements} onChange={(elements) => onChange({ elements })} />
      ) : null}
    </div>
  );
}

function ElementsEditor({
  spec,
  userId,
  value,
  onChange,
}: {
  spec: NonNullable<NonNullable<ModelConfig["options"]["references"]>["elements"]>;
  userId: string;
  value: ElementDraft[];
  onChange: (elements: ElementDraft[]) => void;
}) {
  const update = (key: string, patch: Partial<ElementDraft>) => onChange(value.map((e) => (e.key === key ? { ...e, ...patch } : e)));

  return (
    <div className="space-y-3">
      <div>
        <span className="text-xs font-medium uppercase tracking-[0.08em] text-cream-2">Elements (optional)</span>
        <p className="mt-0.5 text-[11px] text-muted">
          Keep a character or product consistent: name it, add {spec.minImages}–{spec.maxImages} photos, then write <span className="font-mono text-cream-2">@name</span> in your
          prompt.{spec.requiresStartFrame ? " Needs a start frame." : ""}
        </p>
      </div>

      {value.map((el, i) => (
        <div key={el.key} className="space-y-3 rounded-[6px] border border-hairline bg-field/40 p-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-gold">@</span>
            <Input
              aria-label={`Element ${i + 1} name`}
              value={el.name}
              onChange={(e) => update(el.key, { name: e.target.value.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40) })}
              placeholder="hero"
              className="h-8 font-mono text-xs"
            />
            <button
              type="button"
              aria-label="Remove element"
              onClick={() => onChange(value.filter((e) => e.key !== el.key))}
              className="rounded p-1.5 text-cream-2 hover:bg-white/5 hover:text-cream"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <MediaInput
            type="image"
            userId={userId}
            label={`Photos of @${el.name || "element"}`}
            hint={`${el.images.length} of ${spec.minImages}–${spec.maxImages}`}
            value={el.images}
            onChange={(images) => update(el.key, { images })}
            slots={spec.maxImages}
          />
        </div>
      ))}

      {value.length < spec.max ? (
        <button
          type="button"
          onClick={() =>
            onChange([...value, { key: crypto.randomUUID(), name: `element_${value.length + 1}`, images: [] }])
          }
          className="flex items-center gap-1.5 text-xs text-cream-2 hover:text-cream"
        >
          <Plus className="size-3.5" /> Add element ({value.length} of {spec.max})
        </button>
      ) : null}
    </div>
  );
}

"use client";

import { Clapperboard, Download, ExternalLink, Loader2, RotateCw, Wand2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { AVATAR_WORDS_PER_SECOND, avatarDurationFor, wordCount } from "@/config/avatar";
import type { ModelConfig } from "@/config/models.config";
import { downloadFile, type ApiGeneration } from "@/lib/client-api";
import type { Beat } from "@/lib/types";
import { cn, formatUsd } from "@/lib/utils";
import { DirectionBox, Result, TakeNav, type BeatPatch, type ExampleImage } from "./beat-card";

/** An avatar prompt shorter than this is the splitter's one-line hint, not a written prompt. */
export const MIN_AVATAR_PROMPT_CHARS = 200;

/**
 * One A-roll chunk in the Avatar tab: its line, clip length, the talking-head prompt, and the clip.
 * The clip is animated from the board's avatar still, so there is no per-beat image here.
 */
export function AvatarCard({
  beat,
  index,
  model,
  generation,
  animating,
  avatarReady,
  userId,
  canEdit,
  onPatch,
  onAnimate,
  onReprompt,
  onShowGeneration,
  onDeleteTake,
}: {
  beat: Beat;
  /** Position in the whole board (so numbers match the Storyboard tab). */
  index: number;
  model: ModelConfig;
  generation: ApiGeneration | null;
  animating: boolean;
  avatarReady: boolean;
  userId: string;
  canEdit: boolean;
  onPatch: (patch: BeatPatch) => void;
  onAnimate: () => void;
  onReprompt: (direction: string, attachResult: boolean, exampleUrls: string[], fresh: boolean) => Promise<{ prompt: string }>;
  onShowGeneration: (id: string) => void;
  onDeleteTake: (id: string) => Promise<void>;
}) {
  const [repromptOpen, setRepromptOpen] = useState(false);
  const [reprompting, setReprompting] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);

  const durations = model.options.durations ?? [];
  const words = wordCount(beat.vo);
  const suggested = avatarDurationFor(words, durations);
  const duration = beat.video_duration && durations.includes(beat.video_duration) ? beat.video_duration : suggested;
  const tooLong = durations.length ? words / AVATAR_WORDS_PER_SECOND + 1 > Math.max(...durations) : false;
  const hasPrompt = (beat.video_prompt?.trim().length ?? 0) >= MIN_AVATAR_PROMPT_CHARS;
  const busy = animating || (generation?.status === "queued" || generation?.status === "processing");
  const takes = beat.video_generation_ids ?? [];

  async function submitReprompt(direction: string, attach: boolean, examples: ExampleImage[], _addToRefs: boolean, fresh: boolean) {
    setReprompting(true);
    try {
      await onReprompt(direction, attach, examples.map((e) => e.url), fresh);
      setRepromptOpen(false);
      setPromptOpen(true);
      toast.success("Avatar prompt ready!", { duration: 1500 });
    } catch (e) {
      toast.error("Reprompt failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setReprompting(false);
    }
  }

  return (
    <article className="rounded-[8px] border border-hairline bg-surface" id={`avatar-${beat.id}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-2">
        <span className="font-mono text-xs text-muted">#{index + 1}</span>
        <span className="text-[11px] text-cream-2">A-roll</span>
        <span className={cn("ml-auto font-mono text-[11px]", tooLong ? "text-danger" : "text-muted")} title={tooLong ? "Too many words for the longest clip — split this line" : `${words} words ≈ ${(words / AVATAR_WORDS_PER_SECOND).toFixed(1)}s of speech`}>
          {words} words · {duration}s clip
        </span>
      </div>

      <div className="grid gap-4 p-3 md:grid-cols-[1fr_200px]">
        <div className="min-w-0 space-y-3">
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.08em] text-cream-2">Line she speaks</label>
            <Textarea value={beat.vo} readOnly={!canEdit} onChange={(e) => onPatch({ vo: e.target.value })} rows={2} className="font-sans text-[13px]" />
          </div>

          {durations.length ? (
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-[10px] uppercase tracking-[0.08em] text-muted">Clip length</label>
              <Segmented size="sm" value={String(duration)} options={durations.map((d) => ({ value: String(d), label: `${d}s` }))} onChange={(v) => canEdit && onPatch({ video_duration: Number(v) })} />
              {beat.video_duration && beat.video_duration !== suggested ? (
                <button type="button" className="text-[11px] text-gold hover:text-cream" onClick={() => onPatch({ video_duration: null })}>
                  Use suggested ({suggested}s)
                </button>
              ) : (
                <span className="text-[11px] text-muted">auto from the word count</span>
              )}
            </div>
          ) : null}

          <div className="border-t border-hairline pt-3">
            <div className="mb-1 flex items-baseline justify-between">
              <label className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-cream-2">
                <Clapperboard className="size-3" /> Avatar prompt
              </label>
              <div className="flex items-center gap-3">
                {canEdit ? (
                  <button type="button" disabled={reprompting || !avatarReady} title={!avatarReady ? "Add an avatar still first" : undefined} onClick={() => setRepromptOpen((o) => !o)} className="flex items-center gap-1 text-[11px] text-gold hover:text-cream disabled:opacity-50">
                    {reprompting ? <Loader2 className="size-3 animate-spin" /> : <Wand2 className="size-3" />} {hasPrompt ? "Reprompt" : "Write with Claude"}
                  </button>
                ) : null}
                {beat.video_prompt ? (
                  <button type="button" onClick={() => setPromptOpen((o) => !o)} className="text-[11px] text-cream-2 hover:text-cream">
                    {promptOpen ? "Collapse" : "Expand"}
                  </button>
                ) : null}
              </div>
            </div>
            {reprompting ? (
              <div className="mb-2 h-1 overflow-hidden rounded-full bg-white/10">
                <div className="h-full w-1/3 rounded-full bg-gold/80 animate-reprompt" />
              </div>
            ) : null}
            <Textarea
              value={beat.video_prompt ?? ""}
              readOnly={!canEdit}
              onChange={(e) => onPatch({ video_prompt: e.target.value })}
              rows={promptOpen ? 16 : 4}
              className="font-sans text-[12px] leading-relaxed"
              placeholder={hasPrompt ? undefined : "Press “Write with Claude” (or “Write avatar prompts” above) to draft the talking-head prompt for this line from the avatar still."}
            />
            <DirectionBox
              open={repromptOpen}
              busy={reprompting}
              userId={userId}
              placeholder="e.g. make her count the weeks on her fingers · softer, more vulnerable delivery · end on a small knowing smile"
              attachment={null}
              onClose={() => setRepromptOpen(false)}
              onSubmit={submitReprompt}
            />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="relative aspect-[9/16] overflow-hidden rounded-[6px] bg-[#18223d]">
            <Result gen={generation} generating={animating} kind="video" />
            {generation?.result_url && generation.status === "completed" ? (
              <a href={generation.result_url} target="_blank" rel="noopener" className="absolute right-1.5 top-1.5 rounded-full bg-navy/80 p-1.5 text-cream-2 hover:text-cream" title="Open full size">
                <ExternalLink className="size-3.5" />
              </a>
            ) : null}
          </div>
          <TakeNav takes={takes} current={generation?.id ?? null} onShow={onShowGeneration} onDelete={canEdit && !busy ? onDeleteTake : undefined} label="clip" />
          <Button
            variant={generation?.status === "completed" ? "outline" : "gold"}
            size="sm"
            disabled={!canEdit || busy || !avatarReady || !hasPrompt || tooLong}
            title={!avatarReady ? "Add an avatar still first" : !hasPrompt ? "Write the avatar prompt first" : tooLong ? "Line too long for one clip" : undefined}
            onClick={onAnimate}
          >
            {busy ? <Loader2 className="animate-spin" /> : generation ? <RotateCw /> : <Clapperboard />}
            {busy ? "Generating…" : generation ? "Re-roll clip" : "Generate clip"}
          </Button>
          {generation?.status === "completed" && generation.result_url ? (
            <Button variant="ghost" size="sm" onClick={() => downloadFile(generation.result_url!, `aroll-${index + 1}.mp4`)}>
              <Download /> Download
            </Button>
          ) : null}
          {generation?.cost_usd != null ? <span className="text-center font-mono text-[10px] text-muted">{formatUsd(generation.cost_usd)}</span> : null}
        </div>
      </div>
    </article>
  );
}

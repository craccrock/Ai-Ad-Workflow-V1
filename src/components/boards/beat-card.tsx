"use client";

import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, ExternalLink, Loader2, Merge, Plus, RotateCw, Scissors, Sparkles, Trash2, TriangleAlert, Wand2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { ImageThumb } from "@/components/ui/thumb";
import { api, downloadFile, type ApiGeneration, type ApiMedia } from "@/lib/client-api";
import { describeFailure, describeInFlight } from "@/lib/job-status";
import type { Beat, Media, Subject } from "@/lib/types";
import { cn, formatUsd } from "@/lib/utils";
import { RefSlot } from "./ref-slot";

export type BeatPatch = Partial<Pick<Beat, "role" | "vo" | "image_prompt" | "use_subject_lock" | "pose_media_id" | "setting_media_id" | "negative_prompt" | "shot_type" | "style">>;

const isInFlight = (g?: ApiGeneration | null) => g?.status === "queued" || g?.status === "processing";

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Result({ gen, generating }: { gen: ApiGeneration | null; generating: boolean }) {
  const now = useNow(1000);
  if (generating && !gen) {
    return (
      <div className="shimmer flex h-full w-full flex-col items-center justify-center gap-2 text-cream-2">
        <Loader2 className="size-5 animate-spin text-gold" />
        <span className="text-xs uppercase tracking-[0.14em]">Submitting</span>
      </div>
    );
  }
  if (!gen) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center text-cream-2">
        <Sparkles className="size-5 text-muted" />
        <span className="text-xs">No starter image yet</span>
      </div>
    );
  }
  if (isInFlight(gen)) {
    const { label, progress } = describeInFlight(gen, now);
    const s = Math.max(0, Math.floor((now - new Date(gen.created_at).getTime()) / 1000));
    return (
      <div className="shimmer flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center text-cream-2">
        <span className="text-xs uppercase tracking-[0.14em]">{label}</span>
        <span className="font-mono text-[11px] text-muted">{s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`}</span>
        {progress != null ? (
          <div className="h-1 w-24 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-gold/70 transition-[width] duration-1000 ease-linear" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        ) : null}
      </div>
    );
  }
  if (gen.status === "failed") {
    const { title, advice } = describeFailure(gen);
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-4 text-center">
        <TriangleAlert className="size-5 text-danger" />
        <p className="text-xs font-medium text-cream">{title}</p>
        <p className="text-[11px] leading-snug text-cream-2">{advice}</p>
      </div>
    );
  }
  if (!gen.result_url) {
    return <div className="flex h-full w-full items-center justify-center px-4 text-center text-[11px] text-cream-2">File removed after its retention window — press ↻ to make it again.</div>;
  }
  return <ImageThumb src={gen.result_url} alt={gen.prompt ?? ""} sizes="(max-width: 640px) 100vw, 360px" className="object-contain" />;
}

/** Splits VO text into lines in a dialog; every non-empty line becomes its own beat. */
function SplitDialog({ open, onOpenChange, vo, onSplit }: { open: boolean; onOpenChange: (o: boolean) => void; vo: string; onSplit: (parts: string[]) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <SplitDialogBody vo={vo} onSplit={onSplit} onOpenChange={onOpenChange} /> : null}
    </Dialog>
  );
}

function SplitDialogBody({ vo, onSplit, onOpenChange }: { vo: string; onSplit: (parts: string[]) => void; onOpenChange: (o: boolean) => void }) {
  const [text, setText] = useState(vo);
  const parts = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return (
    <DialogContent title="Split this beat" description="Put each visual on its own line. Each line becomes a beat with the same references; the first keeps this beat's prompt and image.">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} className="font-sans" />
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-cream-2">
            {parts.length} beat{parts.length === 1 ? "" : "s"}
          </span>
          <Button
            variant="gold"
            size="sm"
            disabled={parts.length < 2}
            onClick={() => {
              onSplit(parts);
              onOpenChange(false);
            }}
          >
            <Scissors /> Split into {parts.length}
          </Button>
        </div>
      </DialogContent>
  );
}

export function BeatCard({
  beat,
  index,
  total,
  subject,
  media,
  generation,
  generating,
  userId,
  canEdit,
  onPatch,
  onMedia,
  onSplit,
  onMerge,
  onMove,
  onInsertAfter,
  onDelete,
  onGenerate,
  onReprompt,
  onShowGeneration,
}: {
  beat: Beat;
  index: number;
  total: number;
  subject: Subject | null;
  media: Record<string, Media>;
  generation: ApiGeneration | null;
  generating: boolean;
  userId: string;
  canEdit: boolean;
  onPatch: (patch: BeatPatch) => void;
  /** A newly chosen reference image, so the editor can cache the media row. */
  onMedia: (m: ApiMedia) => void;
  onSplit: (parts: string[]) => void;
  onMerge: () => void;
  onMove: (dir: -1 | 1) => void;
  onInsertAfter: () => void;
  onDelete: () => void;
  onGenerate: () => void;
  /** Ask the brain to rewrite the image prompt; resolves with the new prompt. */
  onReprompt: (direction: string) => Promise<string>;
  /** Step through earlier takes; the editor fetches the generation and swaps it in. */
  onShowGeneration: (id: string) => void;
}) {
  const [splitOpen, setSplitOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [repromptOpen, setRepromptOpen] = useState(false);
  const [direction, setDirection] = useState("");
  const [reprompting, setReprompting] = useState(false);
  const directionRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (repromptOpen) directionRef.current?.focus();
  }, [repromptOpen]);

  async function submitReprompt() {
    const d = direction.trim();
    if (!d || reprompting) return;
    setReprompting(true);
    try {
      await onReprompt(d);
      setDirection("");
      setRepromptOpen(false);
      setPromptOpen(true);
      toast.success("Reprompt ready!", { duration: 1500 });
    } catch (e) {
      toast.error("Reprompt failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setReprompting(false);
    }
  }
  const broll = beat.role === "broll";
  const plan = beat.reference_plan ?? {};
  const takes = beat.generation_ids;
  const takeIndex = generation ? takes.indexOf(generation.id) : -1;
  const busy = generating || isInFlight(generation);
  const subjectImage = subject?.media ?? null;

  const pick = (key: "pose_media_id" | "setting_media_id") => (m: ApiMedia | null) => {
    if (m) onMedia(m);
    onPatch({ [key]: m?.id ?? null });
  };

  return (
    <article className={cn("rounded-[8px] border bg-surface", broll ? "border-hairline" : "border-hairline/60 opacity-80")} id={`beat-${beat.id}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-2">
        <span className="font-mono text-xs text-muted">#{index + 1}</span>
        <Segmented<Beat["role"]>
          size="sm"
          aria-label="Role"
          value={beat.role}
          onChange={(role) => canEdit && onPatch({ role })}
          options={[
            { value: "broll", label: "B-roll" },
            { value: "aroll", label: "A-roll" },
          ]}
        />
        {beat.style ? <Badge tone={beat.style === "ugc_real" ? "gold" : "default"}>{beat.style.replace("_", " ")}</Badge> : null}
        {beat.shot_type ? <span className="truncate text-[11px] text-cream-2">{beat.shot_type}</span> : null}
        {plan.mode && plan.mode !== "new" ? (
          <Badge tone={plan.mode === "reuse" ? "success" : "default"} title={plan.library_asset}>
            {plan.mode === "reuse" ? "Reuse library" : "Edit library"}
          </Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          <Button variant="ghost" size="icon" title="Move up" disabled={!canEdit || index === 0} onClick={() => onMove(-1)}>
            <ArrowUp />
          </Button>
          <Button variant="ghost" size="icon" title="Move down" disabled={!canEdit || index === total - 1} onClick={() => onMove(1)}>
            <ArrowDown />
          </Button>
          <Button variant="ghost" size="icon" title="Split into several beats" disabled={!canEdit} onClick={() => setSplitOpen(true)}>
            <Scissors />
          </Button>
          <Button variant="ghost" size="icon" title="Merge with the next beat" disabled={!canEdit || index === total - 1} onClick={onMerge}>
            <Merge />
          </Button>
          <Button variant="ghost" size="icon" title="Add a beat after this one" disabled={!canEdit} onClick={onInsertAfter}>
            <Plus />
          </Button>
          <Button variant="ghost" size="icon" title="Delete beat" disabled={!canEdit} onClick={onDelete} className="hover:text-danger">
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="grid gap-4 p-3 lg:grid-cols-[1fr_200px]">
        <div className="min-w-0 space-y-3">
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.08em] text-cream-2">Voiceover</label>
            <Textarea value={beat.vo} onChange={(e) => onPatch({ vo: e.target.value })} rows={2} readOnly={!canEdit} className="font-sans text-[13px]" placeholder="What is said over this shot" />
          </div>
          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <label className="block text-[10px] font-medium uppercase tracking-[0.08em] text-cream-2">Image prompt</label>
              <div className="flex items-center gap-3">
                <button type="button" disabled={!canEdit || reprompting} onClick={() => setRepromptOpen((v) => !v)} className="flex items-center gap-1 text-[10px] text-gold hover:text-cream disabled:opacity-50">
                  <Wand2 className="size-3" /> Reprompt
                </button>
                <button type="button" onClick={() => setPromptOpen((v) => !v)} className="text-[10px] text-muted hover:text-cream">
                  {promptOpen ? "Collapse" : "Expand"}
                </button>
              </div>
            </div>
            <Textarea
              value={beat.image_prompt}
              onChange={(e) => onPatch({ image_prompt: e.target.value })}
              rows={promptOpen ? 10 : 3}
              readOnly={!canEdit}
              placeholder="Describe the starter image"
              className={cn("font-sans text-[12px] leading-relaxed", reprompting && "opacity-60")}
            />
            {reprompting ? (
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-navy-3">
                <div className="h-full w-1/3 animate-reprompt rounded-full bg-gold" />
              </div>
            ) : null}
            {repromptOpen ? (
              <div className="mt-2 rounded-[6px] border border-gold/40 bg-navy-2 p-2">
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-[0.08em] text-cream-2">Direction for the rewrite</label>
                <Textarea
                  ref={directionRef}
                  value={direction}
                  onChange={(e) => setDirection(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void submitReprompt();
                    }
                    if (e.key === "Escape") setRepromptOpen(false);
                  }}
                  rows={3}
                  disabled={reprompting}
                  className="font-sans text-[12px]"
                  placeholder="e.g. put her in a knit top in front of a full-height mirror in a bigger bathroom; remove the phone; make the prompt longer and more detailed"
                />
                <div className="mt-1.5 flex items-center justify-between">
                  <span className="text-[10px] text-muted">Enter to send · Shift+Enter for a new line</span>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" disabled={reprompting} onClick={() => setRepromptOpen(false)}>
                      Cancel
                    </Button>
                    <Button variant="gold" size="sm" disabled={reprompting || !direction.trim()} onClick={() => void submitReprompt()}>
                      {reprompting ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
                      {reprompting ? "Rewriting…" : "Reprompt"}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
            {plan.mode === "edit" && plan.edit_note ? <p className="mt-1 text-[11px] text-cream-2">Edit note: {plan.edit_note}</p> : null}
          </div>

          {broll ? (
            <div>
              <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-cream-2">References</div>
              <div className="grid grid-cols-3 gap-2">
                <div className={cn("min-w-0", !beat.use_subject_lock && "opacity-50")}>
                  <div className="mb-1 flex items-center justify-between gap-1">
                    <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-cream-2">Subject</span>
                    <label className="flex items-center gap-1 text-[10px] text-muted">
                      <input type="checkbox" checked={beat.use_subject_lock} disabled={!canEdit} onChange={(e) => onPatch({ use_subject_lock: e.target.checked })} className="accent-gold" />
                      lock
                    </label>
                  </div>
                  <div className="relative aspect-[3/4] overflow-hidden rounded-[6px] border border-hairline bg-field">
                    {subjectImage ? (
                      <ImageThumb src={subjectImage.url} alt={subject?.name ?? "Subject"} sizes="160px" className="object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center px-2 text-center text-[10px] text-muted">{subject ? "Subject has no base image" : "No subject lock on this board"}</div>
                    )}
                  </div>
                </div>
                <RefSlot label="Pose" hint={plan.pose_ref && !beat.pose_media_id ? `wanted: ${plan.pose_ref}` : undefined} media={beat.pose_media_id ? media[beat.pose_media_id] : null} userId={userId} onChange={pick("pose_media_id")} disabled={!canEdit} compact />
                <RefSlot label="Setting" hint={plan.setting_ref && !beat.setting_media_id ? plan.setting_ref : undefined} media={beat.setting_media_id ? media[beat.setting_media_id] : null} userId={userId} onChange={pick("setting_media_id")} disabled={!canEdit} compact />
              </div>
            </div>
          ) : (
            <p className="text-[11px] text-muted">A-roll: covered by the talking head, no starter image needed. Switch to B-roll to generate one.</p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <div className="relative aspect-[9/16] overflow-hidden rounded-[6px] bg-[#18223d]">
            <Result gen={generation} generating={generating} />
            {generation?.result_url && generation.status === "completed" ? (
              <a href={generation.result_url} target="_blank" rel="noopener" className="absolute right-1.5 top-1.5 rounded-full bg-navy/80 p-1.5 text-cream-2 hover:text-cream" title="Open full size">
                <ExternalLink className="size-3.5" />
              </a>
            ) : null}
          </div>
          {takes.length > 1 ? (
            <div className="flex items-center justify-between text-[11px] text-cream-2">
              <button type="button" disabled={takeIndex <= 0} onClick={() => onShowGeneration(takes[takeIndex - 1])} className="rounded p-1 hover:text-cream disabled:opacity-30" aria-label="Previous take">
                <ChevronLeft className="size-4" />
              </button>
              <span className="font-mono">
                take {takeIndex + 1}/{takes.length}
              </span>
              <button type="button" disabled={takeIndex < 0 || takeIndex >= takes.length - 1} onClick={() => onShowGeneration(takes[takeIndex + 1])} className="rounded p-1 hover:text-cream disabled:opacity-30" aria-label="Next take">
                <ChevronRight className="size-4" />
              </button>
            </div>
          ) : null}
          {broll ? (
            <Button variant={generation?.status === "completed" ? "outline" : "gold"} size="sm" disabled={!canEdit || busy || !beat.image_prompt.trim()} onClick={onGenerate}>
              {busy ? <Loader2 className="animate-spin" /> : generation ? <RotateCw /> : <Sparkles />}
              {busy ? "Generating…" : generation ? "Re-roll" : "Generate"}
            </Button>
          ) : null}
          {generation?.status === "completed" && generation.result_url ? (
            <Button variant="ghost" size="sm" onClick={() => downloadFile(generation.result_url!, `beat-${index + 1}.png`)}>
              <Download /> Download
            </Button>
          ) : null}
          {generation?.cost_usd != null ? <span className="text-center font-mono text-[10px] text-muted">{formatUsd(generation.cost_usd)}</span> : null}
        </div>
      </div>

      <SplitDialog open={splitOpen} onOpenChange={setSplitOpen} vo={beat.vo} onSplit={onSplit} />
    </article>
  );
}

/** Fetches one generation by id (for stepping through takes). */
export function fetchGeneration(id: string) {
  return api<ApiGeneration>(`/api/generate/${id}`);
}

"use client";

import { Captions as CaptionsIcon, Download, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { api, downloadFile } from "@/lib/client-api";
import type { CaptionsJob } from "@/lib/types";

const PRESETS: { id: CaptionsJob["preset"]; label: string; hint: string }[] = [
  { id: "capcut", label: "CapCut word highlight", hint: "Uppercase bold words in a dark pill, the spoken word in yellow" },
  { id: "hormozi", label: "Hormozi big bold", hint: "Huge outlined words, no box, the spoken word in green" },
  { id: "clean", label: "Clean lower third", hint: "One line at a time in a translucent bar" },
];

/**
 * Captions on the finished ad, rendered by the Remotion worker. Pick a look, press Add captions, watch the
 * progress; the result appears with a download. Polls while a job is running.
 */
export function CaptionsPanel({ boardId, initial, canEdit, canRender, title }: { boardId: string; initial: CaptionsJob | null; canEdit: boolean; canRender: boolean; title: string }) {
  const [job, setJob] = useState<CaptionsJob | null>(initial);
  const [preset, setPreset] = useState<CaptionsJob["preset"]>(initial?.preset ?? "capcut");
  const [starting, setStarting] = useState(false);
  const busy = job?.status === "queued" || job?.status === "rendering";

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => {
      void api<{ captions: CaptionsJob | null }>(`/api/boards/${boardId}/captions`)
        .then((r) => {
          setJob(r.captions);
          if (r.captions?.status === "ready") toast.success("Captions rendered");
          if (r.captions?.status === "failed") toast.error("Caption render failed", { description: r.captions.error });
        })
        .catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [busy, boardId]);

  async function start() {
    setStarting(true);
    try {
      const r = await api<{ captions: CaptionsJob }>(`/api/boards/${boardId}/captions`, { method: "POST", json: { preset } });
      setJob(r.captions);
      toast.success("Rendering captions", { description: "Usually two to four minutes for a one-minute ad." });
    } catch (e) {
      toast.error("Couldn't start the caption render", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="space-y-2 rounded-[6px] border border-hairline bg-field/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.08em] text-cream-2">
          <CaptionsIcon className="size-3" /> Captions
        </div>
        <NativeSelect value={preset} onChange={(e) => setPreset(e.target.value as CaptionsJob["preset"])} disabled={!canEdit || busy} className="h-7 text-[12px]" title={PRESETS.find((p) => p.id === preset)?.hint}>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </NativeSelect>
        <Button size="sm" variant={job?.status === "ready" ? "outline" : "gold"} disabled={!canEdit || !canRender || busy || starting} onClick={() => void start()} title={canRender ? PRESETS.find((p) => p.id === preset)?.hint : "Needs a finished ad with a transcript"}>
          {busy || starting ? <Loader2 className="animate-spin" /> : <CaptionsIcon />} {busy ? (job?.status === "queued" ? "Queued…" : `Rendering ${Math.round((job?.progress ?? 0) * 100)}%`) : job?.status === "ready" ? "Re-render captions" : "Add captions"}
        </Button>
        {job?.status === "ready" && job.url ? (
          <Button size="sm" variant="outline" onClick={() => void downloadFile(job.url!, `${title.replace(/[^\w-]+/g, "_") || "board"}-captioned.mp4`)}>
            <Download /> Download captioned ad
          </Button>
        ) : null}
      </div>
      {busy ? (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-field">
          <div className="h-full bg-gold transition-[width]" style={{ width: `${Math.max(3, Math.round((job?.progress ?? 0) * 100))}%` }} />
        </div>
      ) : null}
      {job?.status === "failed" ? <p className="text-[11px] text-danger">{job.error}</p> : null}
      {job?.status === "ready" && job.url ? (
        <div className="grid gap-3 md:grid-cols-[220px_1fr]">
          <div className="relative aspect-[9/16] overflow-hidden rounded-[6px] bg-black">
            <video key={job.url} src={job.url} controls playsInline preload="metadata" className="h-full w-full object-contain" />
          </div>
          <p className="text-[11px] leading-snug text-cream-2">
            {PRESETS.find((p) => p.id === job.preset)?.label} · rendered {new Date(job.updated_at).toLocaleString()}. Captions come from the A-roll word timestamps, so a line the voice changed shows what was actually said.
          </p>
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { Film, Loader2, RefreshCw, Trash2, Upload, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/misc";
import { api } from "@/lib/client-api";
import type { EditNote, ReferenceEdit } from "@/lib/types";
import { uploadMedia } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { CutRulesEditor } from "./cut-rules-editor";

export type PastCut = {
  board_id: string;
  title: string;
  aroll: { duration_s: number; clips: number; created_at: string; url: string } | null;
  final: { duration_s: number; placed: number; skipped: number; created_at: string; url: string } | null;
  notes: EditNote[];
};

const KIND_TONE: Record<string, string> = { speaker: "bg-gold/80", broll: "bg-cream/70", text: "bg-sky-400/70", other: "bg-muted/60" };

/** Shot-by-shot bar: gold is the presenter, cream is B-roll. Hover a segment for what's in it. */
function ShotBar({ ref_ }: { ref_: ReferenceEdit }) {
  const d = ref_.duration_s || 1;
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-[3px] bg-field" title="Shot timeline: gold = presenter, cream = B-roll">
      {(ref_.shots ?? []).map((s) => (
        <div key={s.i} className={cn("h-full border-r border-navy/60 last:border-r-0", KIND_TONE[s.kind])} style={{ width: `${((s.end - s.start) / d) * 100}%` }} title={`${s.start}–${s.end}s · ${s.kind}${s.what ? `: ${s.what}` : ""}`} />
      ))}
    </div>
  );
}

function ReferenceCard({ r, isAdmin, onChange, onRemove }: { r: ReferenceEdit; isAdmin: boolean; onChange: (r: ReferenceEdit) => void; onRemove: () => void }) {
  const [busy, setBusy] = useState<"apply" | "reanalyze" | "delete" | null>(null);
  const p = r.profile;

  async function act(action: "apply" | "reanalyze") {
    setBusy(action);
    try {
      const res = await api<{ reference?: ReferenceEdit; applied?: Record<string, unknown> }>(`/api/training/references/${r.id}`, { method: "POST", json: { action } });
      if (res.reference) onChange(res.reference);
      if (action === "apply") toast.success("Pacing applied to the cutter", { description: "Knobs set from this reference and its paragraph added to the style guide." });
      else toast.success("Re-analysed");
    } catch (e) {
      toast.error(action === "apply" ? "Couldn't apply" : "Analysis failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove "${r.title}" from the references? The uploaded file stays in the library.`)) return;
    setBusy("delete");
    try {
      await api(`/api/training/references/${r.id}`, { method: "DELETE" });
      onRemove();
    } catch (e) {
      toast.error("Couldn't remove", { description: e instanceof Error ? e.message : String(e) });
      setBusy(null);
    }
  }

  return (
    <Card className="grid gap-4 p-3 md:grid-cols-[160px_1fr]">
      <div className="relative aspect-[9/16] overflow-hidden rounded-[6px] bg-black">
        <video src={r.url} controls playsInline preload="metadata" className="h-full w-full object-contain" />
      </div>
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium text-cream">{r.title}</h3>
          <Badge tone={r.status === "ready" ? "success" : r.status === "failed" ? "danger" : "default"}>{r.status === "ready" ? "analysed" : r.status === "failed" ? "failed" : "analysing…"}</Badge>
          {r.duration_s ? <span className="text-[11px] text-muted">{r.duration_s}s</span> : null}
          <div className="ml-auto flex gap-1.5">
            {isAdmin && r.status === "ready" ? (
              <Button size="sm" variant="gold" disabled={!!busy} onClick={() => void act("apply")} title="Set the cutter's pacing knobs from this ad and add its description to the style guide">
                {busy === "apply" ? <Loader2 className="animate-spin" /> : <Wand2 />} Use this pacing
              </Button>
            ) : null}
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void act("reanalyze")} title="Run the analysis again">
              {busy === "reanalyze" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            </Button>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void remove()} title="Remove this reference">
              {busy === "delete" ? <Loader2 className="animate-spin" /> : <Trash2 />}
            </Button>
          </div>
        </div>
        {r.status === "failed" ? <p className="text-[12px] text-danger">{r.error}</p> : null}
        {r.shots?.length ? <ShotBar ref_={r} /> : null}
        {p ? (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] text-cream-2 sm:grid-cols-3 lg:grid-cols-4">
              <span>
                Opens on presenter <b className="font-mono text-cream">{p.opens_on_speaker_s}s</b>
              </span>
              <span>
                B-roll share <b className="font-mono text-cream">{Math.round(p.broll_share * 100)}%</b>
              </span>
              <span>
                B-roll runs <b className="font-mono text-cream">{p.broll_runs.count}</b> · {p.broll_runs.min}–{p.broll_runs.max}s
              </span>
              <span>
                Returns to her <b className="font-mono text-cream">{p.speaker_returns.count}</b>
                {p.speaker_returns.count ? ` · ${p.speaker_returns.min}–${p.speaker_returns.max}s` : ""}
              </span>
              <span>
                Cuts/min <b className="font-mono text-cream">{p.cuts_per_minute}</b>
              </span>
              <span>
                B-roll lead <b className="font-mono text-cream">{p.broll_lead_s == null ? "—" : `${p.broll_lead_s}s`}</b>
              </span>
              <span>
                Closes on <b className="font-mono text-cream">{p.closes_on}</b>
              </span>
              <span>
                Shots <b className="font-mono text-cream">{p.shots}</b>
              </span>
            </div>
            {r.summary ? <p className="text-[12px] leading-snug text-cream-2">{r.summary}</p> : null}
            {p.line_map.length ? (
              <details className="text-[11px]">
                <summary className="cursor-pointer text-muted hover:text-cream-2">Line by line: where the editor went to B-roll</summary>
                <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto">
                  {p.line_map.map((l, i) => (
                    <li key={i} className="flex gap-2">
                      <span className={cn("w-14 shrink-0 font-mono text-[10px]", l.on === "broll" ? "text-cream" : l.on === "speaker" ? "text-gold" : "text-muted")}>{l.on}</span>
                      <span className="text-cream-2">{l.text}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        ) : null}
      </div>
    </Card>
  );
}

export function TrainingPanel({ initialReferences, pastCuts, userId, isAdmin }: { initialReferences: ReferenceEdit[]; pastCuts: PastCut[]; userId: string; isAdmin: boolean }) {
  const [refs, setRefs] = useState(initialReferences);
  const [uploading, setUploading] = useState<string | null>(null);
  const [rulesKey, setRulesKey] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("video/")) {
        toast.error(`${file.name} isn't a video`);
        continue;
      }
      setUploading(`Uploading ${file.name}…`);
      try {
        const media = await uploadMedia(file, userId);
        setUploading(`Analysing ${file.name}… (cuts, presenter vs B-roll, transcript; about a minute)`);
        const res = await api<{ reference: ReferenceEdit }>("/api/training/references", { method: "POST", json: { media_id: media.id, title: file.name.replace(/\.[^.]+$/, "") } });
        setRefs((cur) => [res.reference, ...cur]);
        toast.success(`${res.reference.title} analysed`, { description: `${res.reference.profile?.shots ?? 0} shots, ${Math.round((res.reference.profile?.broll_share ?? 0) * 100)}% B-roll.` });
      } catch (e) {
        toast.error(`Couldn't add ${file.name}`, { description: e instanceof Error ? e.message : String(e) });
        // The row may exist as "failed": refresh the list so it shows with its error and a retry button.
        void api<{ references: ReferenceEdit[] }>("/api/training/references").then((r) => setRefs(r.references)).catch(() => {});
      } finally {
        setUploading(null);
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-serif text-xl text-cream">Reference edits</h2>
          <span className="text-[12px] text-muted">Ads you cut by hand. Each one is read shot by shot and turned into a pacing profile the cutter can follow. Two or three good ones beat ten.</span>
          <input ref={fileRef} type="file" accept="video/mp4,video/quicktime,video/webm" multiple hidden onChange={(e) => void onFiles(e.target.files)} />
          <Button variant="gold" size="sm" className="ml-auto" disabled={!!uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? <Loader2 className="animate-spin" /> : <Upload />} {uploading ? "Working…" : "Upload a reference ad"}
          </Button>
        </div>
        {uploading ? <p className="text-[12px] text-cream-2">{uploading}</p> : null}
        {refs.length ? (
          <div className="space-y-3">
            {refs.map((r) => (
              <ReferenceCard
                key={r.id}
                r={r}
                isAdmin={isAdmin}
                onChange={(n) => {
                  setRefs((cur) => cur.map((x) => (x.id === n.id ? n : x)));
                  setRulesKey((k) => k + 1);
                }}
                onRemove={() => setRefs((cur) => cur.filter((x) => x.id !== r.id))}
              />
            ))}
          </div>
        ) : (
          <Card className="p-6 text-center text-[13px] text-muted">No references yet. Upload a finished ad you edited yourself and the cutter learns its pacing.</Card>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-xl text-cream">Cut rules</h2>
        <Card className="p-3">
          <CutRulesEditor isAdmin={isAdmin} reloadKey={rulesKey} />
        </Card>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-serif text-xl text-cream">Past cuts</h2>
          <span className="text-[12px] text-muted">Every A-roll track and finished ad the cutter has produced, with the notes left on them.</span>
        </div>
        {pastCuts.length ? (
          <div className="grid gap-3 md:grid-cols-2">
            {pastCuts.map((c) => (
              <Card key={c.board_id} className="space-y-2 p-3">
                <div className="flex items-center gap-2">
                  <Film className="size-3.5 text-gold" />
                  <Link href={`/boards/${c.board_id}`} className="font-medium text-cream hover:underline">
                    {c.title}
                  </Link>
                  <span className="ml-auto text-[11px] text-muted">{c.notes.length ? `${c.notes.length} note${c.notes.length === 1 ? "" : "s"}` : "no notes"}</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {c.aroll ? (
                    <a href={c.aroll.url} target="_blank" rel="noreferrer" className="rounded-[6px] border border-hairline p-2 text-[12px] text-cream-2 hover:border-gold/50">
                      <div className="text-[10px] uppercase tracking-[0.08em] text-gold">A-roll track</div>
                      {c.aroll.duration_s}s · {c.aroll.clips} clips · {new Date(c.aroll.created_at).toLocaleDateString()}
                    </a>
                  ) : null}
                  {c.final ? (
                    <a href={c.final.url} target="_blank" rel="noreferrer" className="rounded-[6px] border border-hairline p-2 text-[12px] text-cream-2 hover:border-gold/50">
                      <div className="text-[10px] uppercase tracking-[0.08em] text-cream">Finished ad</div>
                      {c.final.duration_s}s · {c.final.placed} B-roll placed{c.final.skipped ? ` · ${c.final.skipped} skipped` : ""} · {new Date(c.final.created_at).toLocaleDateString()}
                    </a>
                  ) : null}
                </div>
                {c.notes.length ? (
                  <ul className="space-y-0.5 border-t border-hairline pt-2">
                    {c.notes.slice(0, 6).map((n) => (
                      <li key={n.id} className="flex gap-2 text-[11px] text-cream-2">
                        <span className="w-10 shrink-0 font-mono text-[10px] text-muted">{n.target_type === "aroll" ? "A" : "Fin"}</span>
                        <span className="w-10 shrink-0 font-mono text-[10px] text-muted">{n.at_s != null ? `${n.at_s}s` : "—"}</span>
                        <span className="min-w-0 flex-1">{n.note}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Card>
            ))}
          </div>
        ) : (
          <Card className="p-6 text-center text-[13px] text-muted">Nothing assembled yet.</Card>
        )}
      </section>
    </div>
  );
}

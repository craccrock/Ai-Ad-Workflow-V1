"use client";

import { ThumbsUp } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export type StripState = "none" | "running" | "done" | "failed";
export type StripItem = { id: string; n: number; state: StripState; approved?: boolean; title: string };

const SQUARE: Record<StripState, string> = {
  none: "border-red-500/70 bg-red-500/60",
  running: "animate-pulse border-orange-400 bg-orange-400",
  done: "border-emerald-500 bg-emerald-500",
  failed: "border-red-500 bg-red-900",
};

/**
 * One square per beat (or chunk): red = nothing generated yet, orange = generating now, green = generated,
 * green with a thumbs-up = generated and approved. A failed job is dark red with "!". Click a square to jump to it.
 */
export function StatusStrip({ label, items, onPick }: { label: string; items: StripItem[]; onPick?: (id: string) => void }) {
  if (!items.length) return null;
  const count = (s: StripState) => items.filter((i) => i.state === s).length;
  const approved = items.filter((i) => i.approved && i.state === "done").length;
  const done = count("done");
  const running = count("running");
  const failed = count("failed");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="w-14 shrink-0 text-[10px] uppercase tracking-[0.08em] text-muted">{label}</span>
      <div className="flex flex-wrap gap-1">
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            title={`#${it.n} · ${it.state === "none" ? "not generated yet" : it.state === "running" ? "generating" : it.state === "failed" ? "failed" : it.approved ? "generated and approved" : "generated"} · ${it.title}`}
            onClick={() => onPick?.(it.id)}
            className={cn("flex size-[18px] items-center justify-center rounded-[3px] border text-[9px] font-bold leading-none text-white transition-transform hover:scale-125", SQUARE[it.state])}
          >
            {it.state === "done" && it.approved ? <ThumbsUp className="size-[11px]" strokeWidth={3} /> : it.state === "failed" ? "!" : null}
          </button>
        ))}
      </div>
      <span className="font-mono text-[11px] text-cream-2">
        {done}/{items.length}
        <span className="text-muted">
          {approved ? ` · ${approved} approved` : ""}
          {running ? ` · ${running} generating` : ""}
          {failed ? ` · ${failed} failed` : ""}
        </span>
      </span>
    </div>
  );
}

export function StripLegend() {
  const item = (cls: string, text: string, thumb = false) => (
    <span className="flex items-center gap-1">
      <span className={cn("flex size-3 items-center justify-center rounded-[2px] border text-white", cls)}>{thumb ? <ThumbsUp className="size-2" strokeWidth={3} /> : null}</span>
      {text}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
      {item(SQUARE.none, "not generated")}
      {item(SQUARE.running.replace("animate-pulse ", ""), "generating")}
      {item(SQUARE.done, "generated")}
      {item(SQUARE.done, "approved", true)}
    </div>
  );
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * A progress bar for one long step. With `fraction` it fills to that share; without it the bar sweeps (the step
 * reports nothing until it finishes) and only the elapsed time moves. Mount it when the step starts.
 */
export function BusyBar({ label, detail, fraction, className }: { label: string; detail?: string; fraction?: number | null; className?: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  const pct = fraction == null ? null : Math.max(2, Math.min(100, Math.round(fraction * 100)));
  return (
    <div className={cn("rounded-[6px] border border-hairline bg-[#18223d] px-3 py-2", className)}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[11px]">
        <span className="text-cream">{label}</span>
        <span className="font-mono text-muted">
          {pct != null ? `${pct}% · ` : ""}
          {clock(elapsed)}
        </span>
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-white/10">
        {pct != null ? <div className="h-full rounded-full bg-gold/80 transition-[width] duration-700" style={{ width: `${pct}%` }} /> : <div className="absolute inset-y-0 w-1/3 animate-[busy-sweep_1.6s_ease-in-out_infinite] rounded-full bg-gold/70" />}
      </div>
      {detail ? <div className="mt-1.5 text-[11px] text-muted">{detail}</div> : null}
    </div>
  );
}

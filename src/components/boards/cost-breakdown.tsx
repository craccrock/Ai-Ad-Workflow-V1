"use client";

import { Loader2, Receipt, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import type { BoardCosts, PhaseCost } from "@/lib/board-costs";
import { api } from "@/lib/client-api";
import { cn, formatUsd } from "@/lib/utils";

const PHASE_LABEL: Record<PhaseCost["phase"], string> = { image: "Starter images", broll: "B-roll clips", aroll: "A-roll (avatar) clips" };

const money = (n: number) => formatUsd(n);

function Stat({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className="rounded-[6px] border border-hairline bg-[#18223d] px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-[0.08em] text-muted">{label}</div>
      <div className={cn("mt-0.5 font-serif text-xl", strong ? "text-gold" : "text-cream")}>{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-muted">{hint}</div> : null}
    </div>
  );
}

/** Header button showing what the board has cost so far; opens the full breakdown by phase, model and beat. */
export function CostBreakdown({ boardId, refreshKey }: { boardId: string; refreshKey?: number }) {
  const [open, setOpen] = useState(false);
  const [costs, setCosts] = useState<BoardCosts | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCosts = useCallback(() => api<BoardCosts>(`/api/boards/${boardId}/costs`), [boardId]);

  async function load() {
    setLoading(true);
    try {
      setCosts(await fetchCosts());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Keeps the header total current: on open of the page and whenever a new take lands on the board.
  useEffect(() => {
    let live = true;
    fetchCosts()
      .then((c) => live && setCosts(c))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [fetchCosts, refreshKey]);

  const items = costs ? [...costs.items].sort((a, b) => b.total - a.total) : [];
  const rerollShare = costs && costs.total > 0 ? Math.round((costs.rerolls / costs.total) * 100) : 0;

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => { setOpen(true); void load(); }} title="What this board has cost so far, by phase, model and beat">
        <Receipt /> {costs ? `Cost · ${money(costs.total)}` : "Cost"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent wide title="Board cost" description="Every image and clip generated on this board, including re-rolls, deleted takes and takes on beats you later removed. Failed jobs cost nothing.">
          {!costs ? (
            <p className="flex items-center gap-2 text-sm text-cream-2">{error ? `Couldn't load the costs: ${error}` : <><Loader2 className="size-4 animate-spin" /> Adding it up…</>}</p>
          ) : (
            <div className="space-y-5">
              <div className="grid gap-2 sm:grid-cols-4">
                <Stat label="Spent so far" value={money(costs.total)} strong hint={costs.pending > 0 ? `+ about ${money(costs.pending)} still running` : undefined} />
                <Stat label="In the current cut" value={money(costs.kept)} hint="the take selected on each beat and chunk" />
                <Stat label="Re-rolls and discards" value={money(costs.rerolls)} hint={costs.total > 0 ? `${rerollShare}% of the spend` : undefined} />
                <Stat label="Per finished second" value={costs.final_seconds ? money(costs.total / costs.final_seconds) : "—"} hint={costs.final_seconds ? `${Math.round(costs.final_seconds)}s finished ad` : "no finished ad yet"} />
              </div>

              <div className="space-y-3">
                {costs.phases.map((p) => (
                  <div key={p.phase} className="rounded-[6px] border border-hairline">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-hairline px-3 py-2">
                      <span className="text-sm text-cream">{PHASE_LABEL[p.phase]}</span>
                      <span className="text-[11px] text-muted">
                        {p.takes} take{p.takes === 1 ? "" : "s"} · {p.completed} finished{p.failed ? ` · ${p.failed} failed` : ""}{p.running ? ` · ${p.running} running` : ""}
                      </span>
                      <span className="ml-auto text-sm text-cream">{money(p.spent)}</span>
                    </div>
                    {p.takes ? (
                      <div className="px-3 py-2 text-[12px]">
                        <div className="mb-1.5 text-muted">
                          {money(p.kept)} in the current cut · {money(Math.max(0, p.spent - p.kept))} on re-rolls and discards
                          {p.completed ? ` · ${money(p.spent / p.completed)} average per finished take` : ""}
                        </div>
                        <table className="w-full">
                          <tbody>
                            {p.models.map((m) => (
                              <tr key={m.name} className="border-t border-hairline/60">
                                <td className="py-1 text-cream-2">{m.name}</td>
                                <td className="py-1 text-right text-muted">{m.takes} take{m.takes === 1 ? "" : "s"}</td>
                                <td className="w-24 py-1 text-right text-cream">{money(m.spent)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="px-3 py-2 text-[12px] text-muted">Nothing generated yet.</p>
                    )}
                  </div>
                ))}
              </div>

              {items.length ? (
                <div>
                  <div className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-muted">By beat and chunk, most expensive first</div>
                  <div className="overflow-x-auto rounded-[6px] border border-hairline">
                    <table className="w-full min-w-[520px] text-[12px]">
                      <thead>
                        <tr className="text-left text-[10px] uppercase tracking-[0.08em] text-muted">
                          <th className="px-3 py-1.5 font-normal">Item</th>
                          <th className="px-3 py-1.5 text-right font-normal">Images</th>
                          <th className="px-3 py-1.5 text-right font-normal">Clips</th>
                          <th className="px-3 py-1.5 text-right font-normal">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((it) => (
                          <tr key={`${it.kind}-${it.position}`} className="border-t border-hairline/60 align-top">
                            <td className="px-3 py-1.5">
                              <span className="text-cream">{it.kind === "beat" ? `Beat ${it.position}` : `Chunk ${it.position}`}</span>
                              <span className="ml-2 text-muted">{it.label}</span>
                            </td>
                            <td className="whitespace-nowrap px-3 py-1.5 text-right text-cream-2">{it.image.takes ? `${it.image.takes} · ${money(it.image.spent)}` : "—"}</td>
                            <td className="whitespace-nowrap px-3 py-1.5 text-right text-cream-2">{it.video.takes ? `${it.video.takes} · ${money(it.video.spent)}` : "—"}</td>
                            <td className="whitespace-nowrap px-3 py-1.5 text-right text-cream">{money(it.total)}</td>
                          </tr>
                        ))}
                        {costs.removed.takes ? (
                          <tr className="border-t border-hairline/60">
                            <td className="px-3 py-1.5 text-muted" colSpan={3}>
                              {costs.removed.takes} take{costs.removed.takes === 1 ? "" : "s"} no longer on the board (deleted, or their beat or chunk was removed)
                            </td>
                            <td className="px-3 py-1.5 text-right text-cream">{money(costs.removed.spent)}</td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted">
                <span>Counts Kie generations only. Claude prompt writing and ElevenLabs transcription are not included.</span>
                <Button variant="ghost" size="sm" className="ml-auto" disabled={loading} onClick={() => void load()}>
                  {loading ? <Loader2 className="animate-spin" /> : <RotateCw />} Refresh
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

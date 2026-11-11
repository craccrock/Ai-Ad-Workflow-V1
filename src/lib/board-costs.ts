import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { BoardWithBeats } from "@/lib/types";

export type BoardPhase = "image" | "broll" | "aroll";

export type PhaseCost = {
  phase: BoardPhase;
  /** Every job started in this phase, whatever happened to it. */
  takes: number;
  completed: number;
  failed: number;
  running: number;
  /** Charged so far (finished jobs; failed ones cost nothing). */
  spent: number;
  /** Estimate for jobs still running. */
  pending: number;
  /** Cost of the takes currently selected on the board. */
  kept: number;
  models: { name: string; takes: number; spent: number }[];
};

export type ItemCost = {
  kind: "beat" | "chunk";
  position: number;
  label: string;
  image: { takes: number; spent: number };
  video: { takes: number; spent: number };
  total: number;
};

export type BoardCosts = {
  total: number;
  pending: number;
  kept: number;
  /** Spent on takes that are not the selected one: re-rolls, deleted takes, takes of removed beats. */
  rerolls: number;
  phases: PhaseCost[];
  items: ItemCost[];
  /** Spend on takes whose beat or chunk no longer exists (deleted, re-split or re-chunked). */
  removed: { takes: number; spent: number };
  /** Finished ad length in seconds, when one has been cut. */
  final_seconds: number | null;
  first_at: string | null;
  last_at: string | null;
};

type Row = { id: string; model: string; model_display_name: string | null; provider: string; status: string; cost_usd: number | string | null; estimated_cost_usd: number | string | null; board_phase: BoardPhase | null; created_at: string };

const num = (v: number | string | null | undefined) => (v == null ? 0 : Number(v) || 0);
const round = (n: number) => Math.round(n * 10000) / 10000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/** What a board has cost in generations, split by phase, model and beat. Reads every job tagged with the board. */
export async function boardCosts(board: BoardWithBeats): Promise<BoardCosts> {
  const admin = createAdminClient();
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("generations")
      .select("id, model, model_display_name, provider, status, cost_usd, estimated_cost_usd, board_phase, created_at")
      .eq("board_id", board.id)
      .neq("provider", "upload")
      .order("created_at", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) break;
  }

  const spentOf = (r: Row) => (r.status === "completed" ? num(r.cost_usd) : 0);
  const running = (r: Row) => r.status === "queued" || r.status === "processing";
  const byId = new Map(rows.map((r) => [r.id, r]));

  const selected = new Set<string>();
  for (const b of board.beats) {
    if (b.generation_id) selected.add(b.generation_id);
    if (b.video_generation_id) selected.add(b.video_generation_id);
  }
  for (const c of board.avatar_chunks) if (c.generation_id) selected.add(c.generation_id);

  const phases: PhaseCost[] = (["image", "broll", "aroll"] as const).map((phase) => {
    const list = rows.filter((r) => r.board_phase === phase);
    const models = new Map<string, { name: string; takes: number; spent: number }>();
    for (const r of list) {
      const name = r.model_display_name || r.model;
      const m = models.get(name) ?? { name, takes: 0, spent: 0 };
      m.takes += 1;
      m.spent += spentOf(r);
      models.set(name, m);
    }
    return {
      phase,
      takes: list.length,
      completed: list.filter((r) => r.status === "completed").length,
      failed: list.filter((r) => r.status === "failed").length,
      running: list.filter(running).length,
      spent: round(list.reduce((a, r) => a + spentOf(r), 0)),
      pending: round(list.filter(running).reduce((a, r) => a + num(r.estimated_cost_usd), 0)),
      kept: round(list.filter((r) => selected.has(r.id)).reduce((a, r) => a + spentOf(r), 0)),
      models: [...models.values()].map((m) => ({ ...m, spent: round(m.spent) })).sort((a, b) => b.spent - a.spent),
    };
  });

  const attached = new Set<string>();
  const sum = (ids: string[]) => {
    let takes = 0;
    let spent = 0;
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) continue;
      attached.add(id);
      takes += 1;
      spent += spentOf(r);
    }
    return { takes, spent: round(spent) };
  };
  const items: ItemCost[] = [
    ...board.beats.map((b, i) => {
      const image = sum(b.generation_ids ?? []);
      const video = sum(b.video_generation_ids ?? []);
      return { kind: "beat" as const, position: i + 1, label: clip((b.vo || b.image_prompt || "").replace(/\s+/g, " ").trim(), 90), image, video, total: round(image.spent + video.spent) };
    }),
    ...board.avatar_chunks.map((c, i) => {
      const video = sum(c.generation_ids ?? []);
      return { kind: "chunk" as const, position: i + 1, label: clip((c.vo || "").replace(/\s+/g, " ").trim(), 90), image: { takes: 0, spent: 0 }, video, total: video.spent };
    }),
  ].filter((x) => x.image.takes + x.video.takes > 0);

  const orphans = rows.filter((r) => !attached.has(r.id));
  const total = round(phases.reduce((a, p) => a + p.spent, 0));
  const kept = round(phases.reduce((a, p) => a + p.kept, 0));
  return {
    total,
    pending: round(phases.reduce((a, p) => a + p.pending, 0)),
    kept,
    rerolls: round(total - kept),
    phases,
    items,
    removed: { takes: orphans.length, spent: round(orphans.reduce((a, r) => a + spentOf(r), 0)) },
    final_seconds: board.final_assembly?.duration_s ?? null,
    first_at: rows[0]?.created_at ?? null,
    last_at: rows[rows.length - 1]?.created_at ?? null,
  };
}

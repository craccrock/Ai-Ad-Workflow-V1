import "server-only";
import type { LearningTarget } from "@/lib/learning";
import { createAdminClient } from "@/lib/supabase/admin";

type ApprovedRow = { prompt: string | null; model: string | null; meta: { vo?: string; reprompts?: number; corrections?: string[]; takes?: number } | null; created_at: string };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/**
 * The editor's thumbs-ups, turned into a block the prompt writers read before they write. Each approved take
 * contributes the prompt that produced it, the line it was for, and the corrections it took to get there, so the
 * writer starts from the standard that gets signed off and avoids the mistakes that needed fixing last time.
 * Returns "" when nothing has been approved yet (or the lookup fails: the writers must never break on this).
 */
export async function approvedExamplesBlock(target: LearningTarget, limit = 5): Promise<string> {
  try {
    const { data } = await createAdminClient()
      .from("learning_events")
      .select("prompt, model, meta, created_at")
      .eq("kind", "thumbs_up")
      .eq("target_type", target)
      .not("prompt", "is", null)
      .order("created_at", { ascending: false })
      .limit(limit * 4);
    const seen = new Set<string>();
    const rows: ApprovedRow[] = [];
    for (const r of (data ?? []) as ApprovedRow[]) {
      const p = (r.prompt ?? "").trim();
      if (p.length < 40 || seen.has(p)) continue;
      seen.add(p);
      rows.push(r);
      if (rows.length >= limit) break;
    }
    if (!rows.length) return "";
    const what = target === "beat_image" ? "image prompts" : target === "beat_video" ? "B-roll video prompts" : "talking-head video prompts";
    const items = rows.map((r, i) => {
      const meta = r.meta ?? {};
      const fixes = (meta.corrections ?? []).filter(Boolean).slice(-3);
      const path = fixes.length ? `took ${fixes.length} correction${fixes.length === 1 ? "" : "s"} to get here: ${fixes.map((c) => `"${clip(c.replace(/\s+/g, " "), 220)}"`).join("; ")}` : "approved first try";
      return `[${i + 1}] line: "${clip((meta.vo ?? "").replace(/\s+/g, " "), 160)}" · ${r.model ?? "model unknown"} · ${path}\nPROMPT: ${clip((r.prompt ?? "").trim(), 1400)}`;
    });
    return `\n\nAPPROVED EXAMPLES (${what} this editor gave a thumbs-up, newest first). These define the standard here: the level of concrete detail, the structure, the realism cues and the phrasing that produced a result the editor signed off on. Write to that standard. Do not copy their subject matter unless the line calls for it. Where corrections are listed, they are what the first draft got wrong: build those fixes in from the start.\n\n${items.join("\n\n")}`;
  } catch {
    return "";
  }
}

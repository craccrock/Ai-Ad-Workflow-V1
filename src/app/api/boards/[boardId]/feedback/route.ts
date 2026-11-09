import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor } from "@/lib/boards";
import { generationSnapshot, logLearning, THUMBS_DOWN_TAGS } from "@/lib/learning";
import { createAdminClient } from "@/lib/supabase/admin";
import type { EditNote } from "@/lib/types";

const noteSchema = z.object({
  target_type: z.enum(["aroll", "final"]),
  note: z.string().trim().min(1).max(2000),
  at_s: z.number().min(0).max(3600).nullable().optional(),
});

const bodySchema = z.object({
  target_type: z.enum(["beat_image", "beat_video", "chunk"]),
  target_id: z.string().uuid(),
  generation_id: z.string().uuid(),
  tag: z.enum(THUMBS_DOWN_TAGS),
  note: z.string().trim().max(500).optional(),
});

/** POST /api/boards/:id/feedback — a thumbs-down on a take or clip, with a reason tag. Pure learning signal. */
export async function POST(request: Request, ctx: RouteContext<"/api/boards/[boardId]/feedback">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can leave feedback");
    const raw = await request.json().catch(() => null);
    const asNote = noteSchema.safeParse(raw);
    if (asNote.success) {
      // An editor's note on a cut: what was wrong, at what second, against the exact decisions the cutter made.
      const snapshot = asNote.data.target_type === "aroll" ? board.avatar_assembly : board.final_assembly;
      const { data: row } = await createAdminClient()
        .from("learning_events")
        .insert({ user_id: actor.profile.id, board_id: board.id, kind: "edit_note", target_type: asNote.data.target_type, note: asNote.data.note, meta: { at_s: asNote.data.at_s ?? null, assembly: snapshot ? { ...snapshot, words: undefined } : null } })
        .select("id, target_type, note, meta, created_at, user_id")
        .single();
      return Response.json({ note: row ? { id: row.id, target_type: row.target_type, note: row.note, at_s: (row.meta as { at_s?: number | null })?.at_s ?? null, created_at: row.created_at, user_id: row.user_id } : null });
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, "Invalid body", parsed.error.issues);
    const snap = await generationSnapshot(parsed.data.generation_id);
    await logLearning({ user_id: actor.profile.id, board_id: board.id, kind: "thumbs_down", target_type: parsed.data.target_type, target_id: parsed.data.target_id, generation_id: parsed.data.generation_id, model: snap.model, prompt: snap.prompt, tag: parsed.data.tag, note: parsed.data.note ?? null });
    return Response.json({ ok: true });
  });
}

/** GET /api/boards/:id/feedback?target=aroll|final — the editor's notes on that output, newest first. */
export async function GET(request: Request, ctx: RouteContext<"/api/boards/[boardId]/feedback">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId } = await ctx.params;
    await getBoardForActor(actor, boardId);
    const target = new URL(request.url).searchParams.get("target");
    let q = createAdminClient().from("learning_events").select("id, target_type, note, meta, created_at, user_id").eq("board_id", boardId).eq("kind", "edit_note").order("created_at", { ascending: false }).limit(50);
    if (target === "aroll" || target === "final") q = q.eq("target_type", target);
    const { data, error } = await q;
    if (error) throw new HttpError(500, error.message);
    const notes: EditNote[] = (data ?? []).map((r) => ({ id: r.id as string, target_type: r.target_type as "aroll" | "final", note: (r.note as string) ?? "", at_s: ((r.meta as { at_s?: number | null })?.at_s ?? null) as number | null, created_at: r.created_at as string, user_id: (r.user_id as string | null) ?? null }));
    return Response.json({ notes });
  });
}

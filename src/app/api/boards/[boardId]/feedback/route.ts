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

const voteSchema = z.object({
  target_type: z.enum(["beat_image", "beat_video", "chunk"]),
  target_id: z.string().uuid(),
  generation_id: z.string().uuid(),
  vote: z.enum(["up", "clear"]),
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
    const asVote = voteSchema.safeParse(raw);
    if (asVote.success) {
      // Thumbs-up: "this is what we're going for". Stored with the prompt that made the take and the corrections
      // it took to get there, and read back by the prompt writers as approved examples.
      const v = asVote.data;
      const admin = createAdminClient();
      await admin.from("learning_events").delete().eq("kind", "thumbs_up").eq("generation_id", v.generation_id);
      if (v.vote === "clear") return Response.json({ ok: true, approved: false });
      const table = v.target_type === "chunk" ? "avatar_chunks" : "beats";
      const idsCol = v.target_type === "beat_video" ? "video_generation_ids" : "generation_ids";
      const [snap, { data: target }, { data: fixes }] = await Promise.all([
        generationSnapshot(v.generation_id),
        admin.from(table).select(`vo, ${idsCol}`).eq("id", v.target_id).maybeSingle(),
        admin.from("learning_events").select("direction, created_at").eq("kind", "reprompt").eq("target_type", v.target_type).eq("target_id", v.target_id).order("created_at", { ascending: true }).limit(12),
      ]);
      const row = (target ?? {}) as Record<string, unknown>;
      const corrections = ((fixes ?? []) as { direction: string | null }[]).map((f) => (f.direction ?? "").trim()).filter(Boolean);
      const takes = Array.isArray(row[idsCol]) ? (row[idsCol] as string[]).length : 1;
      await logLearning({ user_id: actor.profile.id, board_id: board.id, kind: "thumbs_up", target_type: v.target_type, target_id: v.target_id, generation_id: v.generation_id, model: snap.model, prompt: snap.prompt, meta: { vo: (row.vo as string | undefined) ?? "", takes, reprompts: corrections.length, corrections, one_shot: takes <= 1 && corrections.length === 0 } });
      return Response.json({ ok: true, approved: true });
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
    if (new URL(request.url).searchParams.get("approved")) {
      const { data: ups } = await createAdminClient().from("learning_events").select("generation_id").eq("board_id", boardId).eq("kind", "thumbs_up").not("generation_id", "is", null);
      return Response.json({ approved: (ups ?? []).map((u) => u.generation_id as string) });
    }
    const target = new URL(request.url).searchParams.get("target");
    let q = createAdminClient().from("learning_events").select("id, target_type, note, meta, created_at, user_id").eq("board_id", boardId).eq("kind", "edit_note").order("created_at", { ascending: false }).limit(50);
    if (target === "aroll" || target === "final") q = q.eq("target_type", target);
    const { data, error } = await q;
    if (error) throw new HttpError(500, error.message);
    const notes: EditNote[] = (data ?? []).map((r) => ({ id: r.id as string, target_type: r.target_type as "aroll" | "final", note: (r.note as string) ?? "", at_s: ((r.meta as { at_s?: number | null })?.at_s ?? null) as number | null, created_at: r.created_at as string, user_id: (r.user_id as string | null) ?? null }));
    return Response.json({ notes });
  });
}

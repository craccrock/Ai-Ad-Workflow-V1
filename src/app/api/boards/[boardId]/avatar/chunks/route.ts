import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor, loadBoardWithBeats } from "@/lib/boards";
import { chunkScript, loadAvatarChunks } from "@/lib/boards-avatar";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 300;

/** POST /api/boards/:id/avatar/chunks — cuts the whole script into clip-sized chunks (replaces the current list). */
export async function POST(request: Request, ctx: RouteContext<"/api/boards/[boardId]/avatar/chunks">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can chunk the script");
    const full = await loadBoardWithBeats(board);
    const { chunks, usage } = await chunkScript(board, full.beats.map((b) => b.vo));
    return Response.json({ chunks, usage });
  });
}

const putSchema = z.object({
  chunks: z
    .array(
      z.object({
        id: z.string().uuid(),
        vo: z.string().max(2000),
        duration: z.number().int().min(1).max(60).nullable(),
        video_prompt: z.string().max(6000).nullable(),
      }),
    )
    .max(200),
});

/** PUT /api/boards/:id/avatar/chunks — saves edits to existing chunks (line, length, prompt) in the order given. */
export async function PUT(request: Request, ctx: RouteContext<"/api/boards/[boardId]/avatar/chunks">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can edit chunks");
    const parsed = putSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Invalid body", parsed.error.issues);
    const admin = createAdminClient();
    const existing = new Set((await loadAvatarChunks(boardId)).map((c) => c.id));
    await Promise.all(
      parsed.data.chunks
        .filter((c) => existing.has(c.id))
        .map((c, position) => admin.from("avatar_chunks").update({ vo: c.vo, duration: c.duration, video_prompt: c.video_prompt, position }).eq("id", c.id).eq("board_id", boardId)),
    );
    await admin.from("boards").update({ updated_at: new Date().toISOString() }).eq("id", boardId);
    return Response.json({ chunks: await loadAvatarChunks(boardId) });
  });
}

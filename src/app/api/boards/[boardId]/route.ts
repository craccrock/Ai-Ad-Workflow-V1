import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor, loadBoardWithBeats } from "@/lib/boards";
import { createAdminClient } from "@/lib/supabase/admin";

/** GET /api/boards/:id — the board with beats, referenced media and latest generations. */
export async function GET(request: Request, ctx: RouteContext<"/api/boards/[boardId]">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    return Response.json(await loadBoardWithBeats(board));
  });
}

const patchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  script: z.string().max(40000).optional(),
  subject_id: z.string().uuid().nullable().optional(),
  model: z.string().min(1).optional(),
  aspect_ratio: z.string().min(3).optional(),
  resolution: z.string().min(2).optional(),
  video_model: z.string().min(1).optional(),
  video_duration: z.number().int().min(1).max(60).optional(),
  video_resolution: z.string().min(2).nullable().optional(),
});

/** PATCH /api/boards/:id — any of title, script, subject_id, model, aspect_ratio, resolution. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/boards/[boardId]">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can edit it");
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Invalid body", parsed.error.issues);
    const { data, error } = await createAdminClient()
      .from("boards")
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq("id", boardId)
      .select("*")
      .single();
    if (error) throw new HttpError(500, error.message);
    return Response.json(data);
  });
}

/** DELETE /api/boards/:id — removes the board and its beats; generations stay in the gallery. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/boards/[boardId]">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can delete it");
    const { error } = await createAdminClient().from("boards").delete().eq("id", boardId);
    if (error) throw new HttpError(500, error.message);
    return Response.json({ deleted: true, id: boardId });
  });
}

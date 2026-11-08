import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor } from "@/lib/boards";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AvatarChunk } from "@/lib/types";

const bodySchema = z.object({ generation_id: z.string().uuid() });

/** PATCH /api/boards/:id/avatar/chunks/:chunkId/take — makes one of the chunk's clips the current one (what Assemble uses). */
export async function PATCH(request: Request, ctx: RouteContext<"/api/boards/[boardId]/avatar/chunks/[chunkId]/take">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId, chunkId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can pick clips");
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Invalid body");

    const admin = createAdminClient();
    const { data } = await admin.from("avatar_chunks").select("id, generation_ids").eq("id", chunkId).eq("board_id", boardId).maybeSingle();
    if (!data) throw new HttpError(404, "Chunk not found");
    const c = data as Pick<AvatarChunk, "id" | "generation_ids">;
    if (!c.generation_ids.includes(parsed.data.generation_id)) throw new HttpError(404, "That clip is not on this chunk");
    const { error } = await admin.from("avatar_chunks").update({ generation_id: parsed.data.generation_id }).eq("id", chunkId);
    if (error) throw new HttpError(500, error.message);
    return Response.json({ generation_id: parsed.data.generation_id });
  });
}

import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor } from "@/lib/boards";
import { destroyGeneration } from "@/lib/generations";
import { logLearning } from "@/lib/learning";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AvatarChunk } from "@/lib/types";

/** DELETE /api/boards/:id/avatar/chunks/:chunkId/takes/:genId — removes one clip from a chunk and deletes the generation. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/boards/[boardId]/avatar/chunks/[chunkId]/takes/[genId]">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId, chunkId, genId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can delete clips");

    const admin = createAdminClient();
    const { data } = await admin.from("avatar_chunks").select("id, generation_id, generation_ids").eq("id", chunkId).eq("board_id", boardId).maybeSingle();
    if (!data) throw new HttpError(404, "Chunk not found");
    const c = data as Pick<AvatarChunk, "id" | "generation_id" | "generation_ids">;
    const i = c.generation_ids.indexOf(genId);
    if (i < 0) throw new HttpError(404, "That clip is not on this chunk");
    const generation_ids = c.generation_ids.filter((id) => id !== genId);
    const generation_id = c.generation_id === genId ? (generation_ids[Math.min(i, generation_ids.length - 1)] ?? null) : c.generation_id;
    const { error } = await admin.from("avatar_chunks").update({ generation_id, generation_ids }).eq("id", chunkId);
    if (error) throw new HttpError(500, error.message);

    const { data: gen } = await admin.from("generations").select("id, result_storage_path, result_metadata, prompt, model").eq("id", genId).maybeSingle();
    if (gen) {
      void logLearning({ user_id: actor.profile.id, board_id: board.id, kind: "take_delete", target_type: "chunk", target_id: chunkId, generation_id: genId, model: (gen as { model?: string }).model ?? null, prompt: (gen as { prompt?: string }).prompt ?? null, meta: { takes_before: c.generation_ids.length } });
      await destroyGeneration(gen as Parameters<typeof destroyGeneration>[0]);
    }
    return Response.json({ kind: "video", generation_id, generation_ids });
  });
}

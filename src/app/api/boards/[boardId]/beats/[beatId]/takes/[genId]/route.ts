import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor } from "@/lib/boards";
import { destroyGeneration } from "@/lib/generations";
import { logLearning } from "@/lib/learning";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Beat } from "@/lib/types";

/**
 * DELETE /api/boards/:id/beats/:beatId/takes/:genId — removes one take (image or clip) from a beat and deletes
 * the generation itself. If it was the one on display, the neighbouring take becomes current.
 */
export async function DELETE(request: Request, ctx: RouteContext<"/api/boards/[boardId]/beats/[beatId]/takes/[genId]">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId, beatId, genId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can delete takes");

    const admin = createAdminClient();
    const { data: beat } = await admin.from("beats").select("id, generation_id, generation_ids, video_generation_id, video_generation_ids").eq("id", beatId).eq("board_id", boardId).maybeSingle();
    if (!beat) throw new HttpError(404, "Beat not found");
    const b = beat as Pick<Beat, "id" | "generation_id" | "generation_ids" | "video_generation_id" | "video_generation_ids">;

    const kind = b.generation_ids.includes(genId) ? "image" : b.video_generation_ids.includes(genId) ? "video" : null;
    if (!kind) throw new HttpError(404, "That take is not on this beat");
    const list = kind === "image" ? b.generation_ids : b.video_generation_ids;
    const current = kind === "image" ? b.generation_id : b.video_generation_id;
    const i = list.indexOf(genId);
    const nextList = list.filter((id) => id !== genId);
    // Keep whatever was showing unless it is the one being deleted; then fall back to the previous take, else the next.
    const nextCurrent = current === genId ? (nextList[Math.min(i, nextList.length - 1)] ?? null) : current;
    const patch = kind === "image" ? { generation_id: nextCurrent, generation_ids: nextList } : { video_generation_id: nextCurrent, video_generation_ids: nextList };
    const { error } = await admin.from("beats").update(patch).eq("id", beatId);
    if (error) throw new HttpError(500, error.message);

    const { data: gen } = await admin.from("generations").select("id, result_storage_path, result_metadata, prompt, model").eq("id", genId).maybeSingle();
    if (gen) {
      void logLearning({ user_id: actor.profile.id, board_id: board.id, kind: "take_delete", target_type: kind === "image" ? "beat_image" : "beat_video", target_id: beatId, generation_id: genId, model: (gen as { model?: string }).model ?? null, prompt: (gen as { prompt?: string }).prompt ?? null, meta: { takes_before: list.length } });
      await destroyGeneration(gen as Parameters<typeof destroyGeneration>[0]);
    }
    return Response.json({ kind, ...patch });
  });
}

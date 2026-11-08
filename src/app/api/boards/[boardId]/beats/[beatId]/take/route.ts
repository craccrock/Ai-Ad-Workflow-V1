import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor } from "@/lib/boards";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Beat } from "@/lib/types";

const bodySchema = z.object({
  kind: z.enum(["image", "video"]).default("image"),
  generation_id: z.string().uuid(),
});

/**
 * PATCH /api/boards/:id/beats/:beatId/take — makes one of the beat's takes the current one, server-side,
 * so Reprompt, Animate and the next save all see the take the editor is looking at (not the newest).
 */
export async function PATCH(request: Request, ctx: RouteContext<"/api/boards/[boardId]/beats/[beatId]/take">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId, beatId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can pick takes");
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Invalid body");

    const admin = createAdminClient();
    const { data } = await admin.from("beats").select("id, generation_ids, video_generation_ids").eq("id", beatId).eq("board_id", boardId).maybeSingle();
    if (!data) throw new HttpError(404, "Beat not found");
    const b = data as Pick<Beat, "id" | "generation_ids" | "video_generation_ids">;
    const list = parsed.data.kind === "image" ? b.generation_ids : b.video_generation_ids;
    if (!list.includes(parsed.data.generation_id)) throw new HttpError(404, "That take is not on this beat");
    const patch = parsed.data.kind === "image" ? { generation_id: parsed.data.generation_id } : { video_generation_id: parsed.data.generation_id };
    const { error } = await admin.from("beats").update(patch).eq("id", beatId);
    if (error) throw new HttpError(500, error.message);
    return Response.json(patch);
  });
}

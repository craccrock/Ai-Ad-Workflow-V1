import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor } from "@/lib/boards";
import { generationSnapshot, logLearning, THUMBS_DOWN_TAGS } from "@/lib/learning";

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
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Invalid body", parsed.error.issues);
    const snap = await generationSnapshot(parsed.data.generation_id);
    await logLearning({ user_id: actor.profile.id, board_id: board.id, kind: "thumbs_down", target_type: parsed.data.target_type, target_id: parsed.data.target_id, generation_id: parsed.data.generation_id, model: snap.model, prompt: snap.prompt, tag: parsed.data.tag, note: parsed.data.note ?? null });
    return Response.json({ ok: true });
  });
}

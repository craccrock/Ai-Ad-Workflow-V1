import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { beatReferences, canEditBoard, getBoardForActor, loadBoardWithBeats, repromptBeat } from "@/lib/boards";

export const maxDuration = 120;

const bodySchema = z.object({ direction: z.string().trim().min(1).max(4000) });

/** POST /api/boards/:id/beats/:beatId/reprompt — asks the brain to rewrite the beat's image prompt per the editor's direction. */
export async function POST(request: Request, ctx: RouteContext<"/api/boards/[boardId]/beats/[beatId]/reprompt">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId, beatId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can reprompt");
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, "Give a direction first");

    const full = await loadBoardWithBeats(board);
    const beat = full.beats.find((b) => b.id === beatId);
    if (!beat) throw new HttpError(404, "Beat not found");
    const refs = beatReferences(beat, full.subject, full.media);
    return Response.json(await repromptBeat(board, full.subject, beat, parsed.data.direction, refs));
  });
}

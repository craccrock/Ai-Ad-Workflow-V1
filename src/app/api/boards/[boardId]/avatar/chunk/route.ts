import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor, loadBoardWithBeats } from "@/lib/boards";
import { chunkAroll } from "@/lib/boards-avatar";

export const maxDuration = 300;

/**
 * POST /api/boards/:id/avatar/chunk — re-cuts the A-roll narration into clip-sized beats for the avatar model.
 * B-roll beats are untouched. Returns the whole re-numbered beat list.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/boards/[boardId]/avatar/chunk">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can re-chunk");
    const full = await loadBoardWithBeats(board);
    const { beats, usage } = await chunkAroll(board, full.beats);
    return Response.json({ beats, usage });
  });
}

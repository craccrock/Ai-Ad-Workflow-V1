import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor, loadBoardWithBeats, loadSubject, splitBoard } from "@/lib/boards";

// The brain can take a couple of minutes on a long script.
export const maxDuration = 300;

/** POST /api/boards/:id/split — runs the beat splitter on the board's script and replaces its beats. */
export async function POST(request: Request, ctx: RouteContext<"/api/boards/[boardId]/split">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can split it");
    const subject = board.subject_id ? await loadSubject(board.subject_id) : null;
    const { usage } = await splitBoard(board, subject);
    const full = await loadBoardWithBeats({ ...board, brain_output: null });
    return Response.json({ ...full, usage });
  });
}

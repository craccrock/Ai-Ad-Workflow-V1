import { assembleAroll } from "@/lib/assemble";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor, loadBoardWithBeats } from "@/lib/boards";

export const maxDuration = 300;

/** POST /api/boards/:id/avatar/assemble — joins every chunk's clip into one talking-head track. */
export async function POST(request: Request, ctx: RouteContext<"/api/boards/[boardId]/avatar/assemble">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can assemble");
    const full = await loadBoardWithBeats(board);
    if (!full.avatar_chunks.length) throw new HttpError(422, "Chunk the script and generate the clips first");
    const assembly = await assembleAroll(board, full.avatar_chunks, full.generations, actor.profile.id);
    return Response.json({ assembly });
  });
}

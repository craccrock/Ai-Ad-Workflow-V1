import { handleRoute, requireActor } from "@/lib/auth";
import { boardCosts } from "@/lib/board-costs";
import { getBoardForActor, loadBoardWithBeats } from "@/lib/boards";

/** GET /api/boards/:id/costs — what this board has cost in generations, by phase, model and beat. */
export async function GET(request: Request, ctx: RouteContext<"/api/boards/[boardId]/costs">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    return Response.json(await boardCosts(await loadBoardWithBeats(board)));
  });
}

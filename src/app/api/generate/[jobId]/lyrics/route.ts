import { handleRoute, requireActor } from "@/lib/auth";
import { songTiming } from "@/lib/song-timing";

export const maxDuration = 60;

/** GET /api/generate/:jobId/lyrics?take=1 — word and line timings for a finished Suno song. */
export async function GET(request: Request, ctx: RouteContext<"/api/generate/[jobId]/lyrics">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { jobId } = await ctx.params;
    const take = Number(new URL(request.url).searchParams.get("take") ?? 1);
    return Response.json(await songTiming(actor, jobId, Number.isInteger(take) && take > 0 ? take : 1));
  });
}

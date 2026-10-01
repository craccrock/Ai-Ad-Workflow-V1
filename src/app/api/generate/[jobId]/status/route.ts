import { handleRoute, requireActor } from "@/lib/auth";
import { getGenerationForActor, syncGeneration } from "@/lib/generations";

export const maxDuration = 300;

/**
 * GET /api/generate/:jobId/status — the one endpoint the UI polls, regardless of provider.
 * → { status: "queued" | "processing" | "completed" | "failed", retries, resultUrl?, error?, costUsd? }
 *   status "queued" = waiting in the provider's queue, "processing" = generating. `retries` counts automatic resubmissions.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/generate/[jobId]/status">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { jobId } = await ctx.params;
    const row = await syncGeneration(await getGenerationForActor(actor, jobId));
    return Response.json({
      id: row.id,
      status: row.status,
      retries: ((row.result_metadata as { retries?: unknown[] } | null)?.retries ?? []).length,
      resultUrl: row.result_url ?? undefined,
      error: row.error_message ?? undefined,
      costUsd: row.cost_usd != null ? Number(row.cost_usd) : undefined,
      completedAt: row.completed_at ?? undefined,
    });
  });
}

import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor } from "@/lib/boards";
import { createAdminClient } from "@/lib/supabase/admin";
import type { CaptionsJob } from "@/lib/types";

const bodySchema = z.object({ preset: z.enum(["capcut", "hormozi", "clean"]) });

/**
 * POST /api/boards/:id/captions — { preset } asks the render worker to burn captions into the finished ad
 * (Remotion, on the always-on worker). Returns at once; poll GET for progress.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/boards/[boardId]/captions">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can render captions");
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Invalid body", parsed.error.issues);
    const workerUrl = process.env.WORKER_URL?.replace(/\/$/, "");
    const secret = process.env.WORKER_SECRET;
    if (!workerUrl || !secret) throw new HttpError(503, "The render worker isn't configured yet (WORKER_URL / WORKER_SECRET)");
    const source = board.final_assembly?.url ?? board.avatar_assembly?.url;
    const words = board.avatar_assembly?.words;
    if (!source) throw new HttpError(422, "Assemble the A-roll (and cut the B-roll in) first");
    if (!words?.length) throw new HttpError(422, "The A-roll has no transcript yet. Re-assemble it to get word timestamps.");
    if (board.captions?.status === "rendering" || board.captions?.status === "queued") throw new HttpError(409, "A caption render is already running");

    const now = new Date().toISOString();
    const job: CaptionsJob = { status: "queued", preset: parsed.data.preset, source_url: source, progress: 0, created_at: now, updated_at: now };
    const admin = createAdminClient();
    await admin.from("boards").update({ captions: job }).eq("id", boardId);
    let res: Response;
    try {
      res = await fetch(`${workerUrl}/render/captions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-secret": secret },
        body: JSON.stringify({ board_id: boardId, source_url: source, words, preset: parsed.data.preset }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      const message = `Couldn't reach the render worker: ${e instanceof Error ? e.message : String(e)}`;
      await admin.from("boards").update({ captions: { ...job, status: "failed", error: message } }).eq("id", boardId);
      throw new HttpError(502, message);
    }
    if (!res.ok) {
      const message = `Render worker refused the job (${res.status}): ${(await res.text()).slice(0, 300)}`;
      await admin.from("boards").update({ captions: { ...job, status: "failed", error: message } }).eq("id", boardId);
      throw new HttpError(502, message);
    }
    return Response.json({ captions: job });
  });
}

/** GET /api/boards/:id/captions — the current caption job (status, progress, url). */
export async function GET(request: Request, ctx: RouteContext<"/api/boards/[boardId]/captions">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId } = await ctx.params;
    await getBoardForActor(actor, boardId);
    const { data } = await createAdminClient().from("boards").select("captions").eq("id", boardId).maybeSingle();
    return Response.json({ captions: (data?.captions as CaptionsJob | null) ?? null });
  });
}

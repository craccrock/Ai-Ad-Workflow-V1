import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor, loadBoardWithBeats } from "@/lib/boards";
import { hasVideoPrompt, writeVideoPrompts } from "@/lib/boards-video";

export const maxDuration = 300;

const bodySchema = z.object({
  /** "missing" = only B-roll beats without a video prompt; "all" = rewrite every B-roll beat. */
  mode: z.enum(["missing", "all"]).default("missing"),
});

/** POST /api/boards/:id/video-prompts — asks the brain to write video prompts for the board's B-roll beats. */
export async function POST(request: Request, ctx: RouteContext<"/api/boards/[boardId]/video-prompts">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can write video prompts");
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, "Invalid body");

    const full = await loadBoardWithBeats(board);
    const targets = full.beats.filter((b) => b.role === "broll" && b.image_prompt.trim() && (parsed.data.mode === "all" || !hasVideoPrompt(b)));
    if (!targets.length) throw new HttpError(422, parsed.data.mode === "missing" ? "Every B-roll beat already has a video prompt" : "No B-roll beats with an image prompt");
    const stills: Record<string, string> = {};
    for (const b of targets) {
      const g = b.generation_id ? full.generations[b.generation_id] : null;
      if (g?.status === "completed" && g.result_url) stills[b.id] = g.result_url;
    }
    const { prompts, usage } = await writeVideoPrompts(board, full.subject, targets, undefined, stills);
    return Response.json({ prompts, usage });
  });
}

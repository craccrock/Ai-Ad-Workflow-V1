import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor, loadBoardWithBeats } from "@/lib/boards";
import { avatarStillUrl, writeAvatarPrompts } from "@/lib/boards-avatar";

export const maxDuration = 120;

const bodySchema = z.object({
  direction: z.string().trim().min(1).max(4000),
  /** Example images the editor wants Claude to look at (a look or energy to aim for). */
  example_urls: z.array(z.string().url().startsWith("https://")).max(6).default([]),
  /** Ignore the chunk's current prompt and write from the still, the line and the direction only. */
  fresh: z.boolean().default(false),
});

/** POST /api/boards/:id/avatar/chunks/:chunkId/reprompt — rewrites one chunk's talking-head prompt per the editor's direction. */
export async function POST(request: Request, ctx: RouteContext<"/api/boards/[boardId]/avatar/chunks/[chunkId]/reprompt">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId, chunkId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can reprompt");
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, "Give a direction first");

    const full = await loadBoardWithBeats(board);
    const chunk = full.avatar_chunks.find((c) => c.id === chunkId);
    if (!chunk) throw new HttpError(404, "Chunk not found");
    const avatarUrl = avatarStillUrl(full);
    if (!avatarUrl) throw new HttpError(422, "Add an avatar still first (or give the subject a base image)");
    const { prompts, usage } = await writeAvatarPrompts(board, full.subject, full.avatar_chunks, [chunk], avatarUrl, { direction: parsed.data.direction, exampleUrls: parsed.data.example_urls, fresh: parsed.data.fresh });
    const video_prompt = prompts[chunk.id];
    if (!video_prompt) throw new HttpError(502, "The brain returned no avatar prompt");
    return Response.json({ video_prompt, usage });
  });
}

import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor, loadBoardWithBeats } from "@/lib/boards";
import { avatarStillUrl, hasAvatarPrompt, writeAvatarPrompts } from "@/lib/boards-avatar";

export const maxDuration = 300;

const bodySchema = z.object({
  /** "missing" = only chunks without a prompt; "all" = rewrite every chunk. */
  mode: z.enum(["missing", "all"]).default("missing"),
});

/** POST /api/boards/:id/avatar/prompts — asks the brain to write talking-head prompts for the board's chunks. */
export async function POST(request: Request, ctx: RouteContext<"/api/boards/[boardId]/avatar/prompts">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can write avatar prompts");
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, "Invalid body");

    const full = await loadBoardWithBeats(board);
    const avatarUrl = avatarStillUrl(full);
    if (!avatarUrl) throw new HttpError(422, "Add an avatar still first (or give the subject a base image)");
    const targets = full.avatar_chunks.filter((c) => c.vo.trim() && (parsed.data.mode === "all" || !hasAvatarPrompt(c)));
    if (!targets.length) throw new HttpError(422, parsed.data.mode === "missing" ? "Every chunk already has an avatar prompt" : "No chunks yet — chunk the script first");
    const { prompts, usage } = await writeAvatarPrompts(board, full.subject, full.avatar_chunks, targets, avatarUrl);
    return Response.json({ prompts, usage });
  });
}

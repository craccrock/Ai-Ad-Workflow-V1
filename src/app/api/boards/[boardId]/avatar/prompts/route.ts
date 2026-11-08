import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor, loadBoardWithBeats } from "@/lib/boards";
import { avatarStillUrl, writeAvatarPrompts } from "@/lib/boards-avatar";
import { hasVideoPrompt } from "@/lib/boards-video";

export const maxDuration = 300;

const bodySchema = z.object({
  /** "missing" = only A-roll beats without a prompt; "all" = rewrite every A-roll beat. */
  mode: z.enum(["missing", "all"]).default("missing"),
});

/** POST /api/boards/:id/avatar/prompts — asks the brain to write talking-head prompts for the board's A-roll beats. */
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
    const targets = full.beats.filter((b) => b.role === "aroll" && b.vo.trim() && (parsed.data.mode === "all" || !hasVideoPrompt(b)));
    if (!targets.length) throw new HttpError(422, parsed.data.mode === "missing" ? "Every A-roll beat already has an avatar prompt" : "No A-roll beats with a line");
    const { prompts, usage } = await writeAvatarPrompts(board, full.subject, full.beats, targets, avatarUrl);
    return Response.json({ prompts, usage });
  });
}

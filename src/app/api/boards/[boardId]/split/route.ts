import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor, loadBoardWithBeats, loadSubject, splitBoard, type RedoDirection } from "@/lib/boards";
import { getSettings, setSettings } from "@/lib/settings";

// The brain can take a couple of minutes on a long script.
export const maxDuration = 300;

const bodySchema = z.object({
  /** What was wrong with the current board and what to do instead; turns the split into a directed redo. */
  direction: z.string().max(4000).optional(),
  /** Also keep the direction as a standing rule for every future board and reprompt. */
  remember: z.boolean().default(false),
});

/**
 * POST /api/boards/:id/split — runs the beat splitter on the board's script and replaces its beats.
 * With { direction } it is a redo: the splitter is told the previous board was rejected, shown a sample of the
 * prompts being thrown out, and given the editor's direction as its top instruction. { remember: true } appends
 * that direction to the standing image-prompt rules.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/boards/[boardId]/split">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can split it");
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, "Invalid body", parsed.error.issues);
    const direction = parsed.data.direction?.trim() ?? "";

    let redo: RedoDirection | undefined;
    if (direction) {
      const before = await loadBoardWithBeats(board);
      // B-roll first: those are the prompts the editor was looking at when they rejected the board.
      const beats = [...before.beats].sort((a, b) => Number(b.role === "broll") - Number(a.role === "broll"));
      redo = { direction, rejected: beats.filter((b) => b.image_prompt.trim()).map((b) => ({ label: `"${b.vo.trim().slice(0, 120)}"`, prompt: b.image_prompt })) };
    }

    const subject = board.subject_id ? await loadSubject(board.subject_id) : null;
    const { usage } = await splitBoard(board, subject, redo);

    let remembered = false;
    if (direction && parsed.data.remember) {
      const current = (await getSettings()).image_prompt_rules.trim();
      const line = `- ${direction.replace(/\s+/g, " ")}`;
      if (!current.includes(line)) await setSettings({ image_prompt_rules: (current ? `${current}\n${line}` : line).slice(-20000) }, actor.profile.id);
      remembered = true;
    }

    const full = await loadBoardWithBeats({ ...board, brain_output: null });
    return Response.json({ ...full, usage, remembered });
  });
}

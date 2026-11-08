import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { beatReferences, canEditBoard, getBoardForActor, loadBoardWithBeats, repromptBeat } from "@/lib/boards";
import { writeVideoPrompts } from "@/lib/boards-video";
import { logLearning } from "@/lib/learning";

export const maxDuration = 120;

const bodySchema = z.object({
  direction: z.string().trim().min(1).max(4000),
  target: z.enum(["image", "video"]).default("image"),
  /** Show Claude the beat's current result (image target) or starter still (video target) so it can see what went wrong. */
  attach_result: z.boolean().default(false),
  /** Example images the editor wants Claude to look at (the look, framing, realism to aim for). */
  example_urls: z.array(z.string().url().startsWith("https://")).max(6).default([]),
  /** Start from scratch: ignore the current prompt, the brain's edit note and the board subject for this beat. */
  fresh: z.boolean().default(false),
});

/** POST /api/boards/:id/beats/:beatId/reprompt — asks the brain to rewrite the beat's image prompt per the editor's direction. */
export async function POST(request: Request, ctx: RouteContext<"/api/boards/[boardId]/beats/[beatId]/reprompt">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId, beatId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can reprompt");
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, "Give a direction first");

    const full = await loadBoardWithBeats(board);
    const beat = full.beats.find((b) => b.id === beatId);
    if (!beat) throw new HttpError(404, "Beat not found");
    const still = beat.generation_id ? full.generations[beat.generation_id] : null;
    const stillUrl = still?.status === "completed" && still.result_url ? still.result_url : null;
    const common = { user_id: actor.profile.id, board_id: board.id, target_id: beat.id, direction: parsed.data.direction, meta: { vo: beat.vo, examples: parsed.data.example_urls.length, fresh: parsed.data.fresh, result_attached: parsed.data.attach_result && Boolean(stillUrl) } };
    if (parsed.data.target === "video") {
      const { prompts, usage } = await writeVideoPrompts(board, full.subject, [beat], parsed.data.direction, parsed.data.attach_result && stillUrl ? { [beat.id]: stillUrl } : {}, parsed.data.example_urls, parsed.data.fresh);
      const video_prompt = prompts[beat.id];
      if (!video_prompt) throw new HttpError(502, "The brain returned no video prompt");
      void logLearning({ ...common, kind: "reprompt", target_type: "beat_video", generation_id: beat.video_generation_id, prompt: beat.video_prompt, after_prompt: video_prompt });
      return Response.json({ video_prompt, usage });
    }
    const refs = beatReferences(beat, full.subject, full.media);
    const result = await repromptBeat(board, full.subject, beat, parsed.data.direction, refs, { resultUrl: parsed.data.attach_result ? stillUrl : null, exampleUrls: parsed.data.example_urls, fresh: parsed.data.fresh });
    void logLearning({ ...common, kind: "reprompt", target_type: "beat_image", generation_id: parsed.data.attach_result ? beat.generation_id : null, prompt: beat.image_prompt, after_prompt: result.image_prompt, note: result.diagnosis ?? null, model: board.model });
    return Response.json(result);
  });
}

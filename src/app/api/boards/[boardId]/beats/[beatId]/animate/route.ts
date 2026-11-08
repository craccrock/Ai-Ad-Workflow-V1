import { z } from "zod";
import { getModel } from "@/config/models.config";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor, loadBoardWithBeats } from "@/lib/boards";
import { videoSettingsFor } from "@/lib/boards-video";
import { createGenerations, serializeGeneration } from "@/lib/generations";
import { generationSnapshot, logLearning } from "@/lib/learning";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Beat } from "@/lib/types";

export const maxDuration = 300;

const bodySchema = z.object({
  /** Validate and price only. */
  dry_run: z.boolean().default(false),
});

/**
 * POST /api/boards/:id/beats/:beatId/animate — turns the beat's current starter image into a clip
 * (image-to-video) through the normal generation pipeline, and records it on the beat.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/boards/[boardId]/beats/[beatId]/animate">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId, beatId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can animate");
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, "Invalid body");

    const full = await loadBoardWithBeats(board);
    const beat = full.beats.find((b) => b.id === beatId);
    if (!beat) throw new HttpError(404, "Beat not found");
    if (!beat.video_prompt?.trim()) throw new HttpError(422, "This beat has no video prompt yet");
    const still = beat.generation_id ? full.generations[beat.generation_id] : null;
    if (!still || still.status !== "completed" || !still.result_url) throw new HttpError(422, "Generate and pick a starter image first");

    const settings = videoSettingsFor(board, beat);
    const model = getModel(settings.model);
    if (!model) throw new HttpError(400, `Unknown video model "${settings.model}"`);
    const params: Record<string, unknown> = {
      prompt: beat.video_prompt.trim(),
      start_frame_url: still.result_url,
      duration: settings.duration,
      resolution: settings.resolution,
      generate_audio: false,
    };
    if (model.options.aspectRatios && !model.options.aspectRatioTextOnly) params.aspect_ratio = board.aspect_ratio;

    const { estimate, rows } = await createGenerations(actor, {
      model: settings.model,
      params,
      variants: 1,
      is_shared: true,
      dry_run: parsed.data.dry_run,
    });
    if (parsed.data.dry_run) return Response.json({ dry_run: true, model: settings.model, settings, estimate });

    const gen = rows[0];
    if (beat.video_generation_id) {
      void generationSnapshot(beat.video_generation_id).then((snap) => logLearning({ user_id: actor.profile.id, board_id: board.id, kind: "reroll", target_type: "beat_video", target_id: beat.id, generation_id: beat.video_generation_id, model: snap.model, prompt: snap.prompt, meta: { vo: beat.vo, takes_before: beat.video_generation_ids?.length ?? 0 } }));
    }
    const admin = createAdminClient();
    const { data: updated, error } = await admin
      .from("beats")
      .update({ video_generation_id: gen.id, video_generation_ids: [...(beat.video_generation_ids ?? []), gen.id] })
      .eq("id", beatId)
      .select("*")
      .single();
    if (error) throw new HttpError(500, error.message);
    await admin.from("boards").update({ updated_at: new Date().toISOString() }).eq("id", boardId);
    return Response.json({ beat: updated as Beat, generation: serializeGeneration(gen) }, { status: 202 });
  });
}

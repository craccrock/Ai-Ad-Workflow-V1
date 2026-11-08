import { z } from "zod";
import { getModel } from "@/config/models.config";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor, loadBoardWithBeats } from "@/lib/boards";
import { avatarSettingsFor, avatarStillUrl, hasAvatarPrompt } from "@/lib/boards-avatar";
import { createGenerations, serializeGeneration } from "@/lib/generations";
import { generationSnapshot, logLearning } from "@/lib/learning";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AvatarChunk } from "@/lib/types";

export const maxDuration = 300;

const bodySchema = z.object({
  /** Validate and price only. */
  dry_run: z.boolean().default(false),
});

/**
 * POST /api/boards/:id/avatar/chunks/:chunkId/animate — makes the avatar still speak this chunk's line
 * (image-to-video with native voice) through the normal generation pipeline, and records it on the chunk.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/boards/[boardId]/avatar/chunks/[chunkId]/animate">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId, chunkId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can generate clips");
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, "Invalid body");

    const full = await loadBoardWithBeats(board);
    const chunk = full.avatar_chunks.find((c) => c.id === chunkId);
    if (!chunk) throw new HttpError(404, "Chunk not found");
    if (!hasAvatarPrompt(chunk)) throw new HttpError(422, "This chunk has no avatar prompt yet");
    const stillUrl = avatarStillUrl(full);
    if (!stillUrl) throw new HttpError(422, "Add an avatar still first (or give the subject a base image)");

    const settings = avatarSettingsFor(board, chunk);
    const model = getModel(settings.model);
    if (!model) throw new HttpError(400, `Unknown avatar model "${settings.model}"`);
    const params: Record<string, unknown> = {
      prompt: chunk.video_prompt!.trim(),
      start_frame_url: stillUrl,
      duration: settings.duration,
      resolution: settings.resolution,
      generate_audio: true,
    };
    if (model.options.aspectRatios && !model.options.aspectRatioTextOnly) params.aspect_ratio = "9:16";

    const { estimate, rows } = await createGenerations(actor, {
      model: settings.model,
      params,
      variants: 1,
      is_shared: true,
      dry_run: parsed.data.dry_run,
    });
    if (parsed.data.dry_run) return Response.json({ dry_run: true, model: settings.model, settings, estimate });

    const gen = rows[0];
    if (chunk.generation_id) {
      void generationSnapshot(chunk.generation_id).then((snap) => logLearning({ user_id: actor.profile.id, board_id: board.id, kind: "reroll", target_type: "chunk", target_id: chunk.id, generation_id: chunk.generation_id, model: snap.model, prompt: snap.prompt, meta: { vo: chunk.vo, takes_before: chunk.generation_ids?.length ?? 0 } }));
    }
    const admin = createAdminClient();
    const { data: updated, error } = await admin
      .from("avatar_chunks")
      .update({ generation_id: gen.id, generation_ids: [...(chunk.generation_ids ?? []), gen.id] })
      .eq("id", chunkId)
      .select("*")
      .single();
    if (error) throw new HttpError(500, error.message);
    await admin.from("boards").update({ updated_at: new Date().toISOString() }).eq("id", boardId);
    return Response.json({ chunk: updated as AvatarChunk, generation: serializeGeneration(gen) }, { status: 202 });
  });
}

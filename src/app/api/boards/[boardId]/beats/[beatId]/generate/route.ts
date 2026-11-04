import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { beatPrompt, beatReferences, canEditBoard, getBoardForActor, loadBoardWithBeats } from "@/lib/boards";
import { createGenerations, serializeGeneration } from "@/lib/generations";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Beat } from "@/lib/types";

export const maxDuration = 300;

const bodySchema = z.object({
  /** Validate and price only. */
  dry_run: z.boolean().default(false),
});

/**
 * POST /api/boards/:id/beats/:beatId/generate — creates a starter image for one beat through the normal
 * generation pipeline (so it lands in the gallery and Spend), and records it on the beat.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/boards/[boardId]/beats/[beatId]/generate">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId, beatId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can generate");
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, "Invalid body");

    const full = await loadBoardWithBeats(board);
    const beat = full.beats.find((b) => b.id === beatId);
    if (!beat) throw new HttpError(404, "Beat not found");
    if (!beat.image_prompt.trim()) throw new HttpError(422, "This beat has no image prompt");

    const refs = beatReferences(beat, full.subject, full.media);
    const { model, estimate, rows } = await createGenerations(actor, {
      model: board.model,
      params: {
        prompt: beatPrompt(beat),
        image_urls: refs.map((r) => r.url),
        aspect_ratio: board.aspect_ratio,
        resolution: board.resolution,
      },
      variants: 1,
      is_shared: true,
      dry_run: parsed.data.dry_run,
    });
    if (parsed.data.dry_run) return Response.json({ dry_run: true, model: model.id, estimate, references: refs });

    const gen = rows[0];
    const admin = createAdminClient();
    const { data: updated, error } = await admin
      .from("beats")
      .update({ generation_id: gen.id, generation_ids: [...beat.generation_ids, gen.id] })
      .eq("id", beatId)
      .select("*")
      .single();
    if (error) throw new HttpError(500, error.message);
    await admin.from("boards").update({ updated_at: new Date().toISOString() }).eq("id", boardId);
    return Response.json({ beat: updated as Beat, generation: serializeGeneration(gen), references: refs }, { status: 202 });
  });
}

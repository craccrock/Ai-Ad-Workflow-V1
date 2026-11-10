import { randomUUID } from "node:crypto";
import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor } from "@/lib/boards";
import { serializeGeneration } from "@/lib/generations";
import { logLearning } from "@/lib/learning";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Beat, Generation, Media } from "@/lib/types";

const bodySchema = z.object({ media_id: z.string().uuid() });

/**
 * POST /api/boards/:id/beats/:beatId/takes/upload — { media_id } puts an image the editor made elsewhere on the
 * beat as its current take. It is recorded as a finished, zero-cost generation so everything downstream (take
 * switching, Animate, the final cut) treats it like any other take. The file stays in the library and is never
 * cleaned up by retention.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/boards/[boardId]/beats/[beatId]/takes/upload">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId, beatId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can add takes");
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Expected { media_id }");

    const admin = createAdminClient();
    const [{ data: beatRow }, { data: mediaRow }] = await Promise.all([
      admin.from("beats").select("id, vo, image_prompt, generation_id, generation_ids").eq("id", beatId).eq("board_id", boardId).maybeSingle(),
      admin.from("media").select("*").eq("id", parsed.data.media_id).maybeSingle(),
    ]);
    if (!beatRow) throw new HttpError(404, "Beat not found");
    const media = mediaRow as Media | null;
    if (!media) throw new HttpError(404, "Image not found in the library");
    if (media.type !== "image") throw new HttpError(422, "A take has to be an image");
    const beat = beatRow as Pick<Beat, "id" | "vo" | "image_prompt" | "generation_id" | "generation_ids">;

    const now = new Date().toISOString();
    const { data: gen, error } = await admin
      .from("generations")
      .insert({
        id: randomUUID(),
        user_id: actor.profile.id,
        provider: "upload",
        provider_endpoint: null,
        model: "upload",
        model_display_name: "Your upload",
        media_type: "image",
        status: "completed",
        params: { source_media_id: media.id, filename: media.filename },
        prompt: null,
        result_url: media.url,
        result_storage_path: null, // lives in the media library, so retention and take-deletion leave the file alone
        result_metadata: { uploaded: true, width: media.metadata?.width, height: media.metadata?.height },
        estimated_cost_usd: 0,
        cost_usd: 0,
        aspect_ratio: board.aspect_ratio ?? null,
        is_shared: true,
        source: "web",
        created_at: now,
        completed_at: now,
      })
      .select("*")
      .single();
    if (error) throw new HttpError(500, `Couldn't record the upload: ${error.message}`);

    const generation_ids = [...(beat.generation_ids ?? []), (gen as Generation).id];
    const { error: upErr } = await admin.from("beats").update({ generation_id: (gen as Generation).id, generation_ids }).eq("id", beatId);
    if (upErr) throw new HttpError(500, upErr.message);

    // The editor replaced the model's attempts with their own image: the strongest "this prompt didn't get there" signal.
    void logLearning({ user_id: actor.profile.id, board_id: board.id, kind: "take_select", target_type: "beat_image", target_id: beatId, generation_id: (gen as Generation).id, model: "upload", prompt: beat.image_prompt, meta: { vo: beat.vo, uploaded: true, takes_before: beat.generation_ids?.length ?? 0, model_tried: board.model } });
    return Response.json({ generation: serializeGeneration(gen as Generation), generation_id: (gen as Generation).id, generation_ids });
  });
}

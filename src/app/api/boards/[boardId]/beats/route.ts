import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor, loadBoardWithBeats } from "@/lib/boards";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Beat } from "@/lib/types";

const beatSchema = z.object({
  /** Existing beats keep their id; new ones (split / add) come without one. */
  id: z.string().uuid().optional(),
  role: z.enum(["aroll", "broll"]),
  vo: z.string().max(4000),
  shot_type: z.string().max(200).nullable().optional(),
  style: z.string().max(40).nullable().optional(),
  image_prompt: z.string().max(8000),
  video_prompt: z.string().max(4000).nullable().optional(),
  negative_prompt: z.string().max(2000).nullable().optional(),
  reference_plan: z.record(z.string(), z.unknown()).nullable().optional(),
  use_subject_lock: z.boolean().default(true),
  pose_media_id: z.string().uuid().nullable().optional(),
  setting_media_id: z.string().uuid().nullable().optional(),
  extra_media_ids: z.array(z.string().uuid()).max(8).optional(),
  video_model: z.string().max(80).nullable().optional(),
  video_duration: z.number().int().min(1).max(60).nullable().optional(),
  video_resolution: z.string().max(20).nullable().optional(),
  overlay_enabled: z.boolean().optional(),
  overlay_in: z.number().min(0).max(120).optional(),
  overlay_max: z.number().min(0.5).max(120).nullable().optional(),
});

const putSchema = z.object({ beats: z.array(beatSchema).max(200) });

/**
 * PUT /api/boards/:id/beats — replaces the beat list in the given order.
 * Edits, reorders, splits, merges, adds and deletes all go through this one call; beats that keep their id
 * keep their generation history, beats left out are deleted.
 */
export async function PUT(request: Request, ctx: RouteContext<"/api/boards/[boardId]/beats">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can edit beats");
    const parsed = putSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Invalid beats", parsed.error.issues);

    const admin = createAdminClient();
    const { data: existing } = await admin.from("beats").select("id, generation_id, generation_ids, video_generation_id, video_generation_ids").eq("board_id", boardId);
    const known = new Map((existing ?? []).map((b) => [b.id as string, b]));
    const keep = new Set<string>();
    const rows = parsed.data.beats.map((b, position) => {
      const prior = b.id ? known.get(b.id) : undefined;
      if (prior) keep.add(prior.id as string);
      return {
        ...(prior ? { id: prior.id, generation_id: prior.generation_id, generation_ids: prior.generation_ids, video_generation_id: prior.video_generation_id, video_generation_ids: prior.video_generation_ids } : {}),
        board_id: boardId,
        position,
        role: b.role,
        vo: b.vo,
        shot_type: b.shot_type ?? null,
        style: b.style ?? null,
        image_prompt: b.image_prompt,
        video_prompt: b.video_prompt ?? null,
        negative_prompt: b.negative_prompt ?? null,
        reference_plan: b.reference_plan ?? null,
        use_subject_lock: b.use_subject_lock,
        pose_media_id: b.pose_media_id ?? null,
        setting_media_id: b.setting_media_id ?? null,
        extra_media_ids: b.extra_media_ids ?? [],
        video_model: b.video_model ?? null,
        video_duration: b.video_duration ?? null,
        video_resolution: b.video_resolution ?? null,
        overlay_enabled: b.overlay_enabled ?? true,
        overlay_in: b.overlay_in ?? 0,
        overlay_max: b.overlay_max ?? null,
      };
    });

    const gone = [...known.keys()].filter((id) => !keep.has(id));
    if (gone.length) await admin.from("beats").delete().in("id", gone);
    if (rows.length) {
      const { error } = await admin.from("beats").upsert(rows, { onConflict: "id" });
      if (error) throw new HttpError(500, error.message);
    }
    await admin.from("boards").update({ updated_at: new Date().toISOString() }).eq("id", boardId);
    const full = await loadBoardWithBeats(board);
    return Response.json({ beats: full.beats as Beat[], media: full.media });
  });
}

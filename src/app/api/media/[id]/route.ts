import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { describeMedia } from "@/lib/library-cards";
import { removeStorageObject } from "@/lib/storage";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Media } from "@/lib/types";

/** GET /api/media/:id */
export async function GET(request: Request, ctx: RouteContext<"/api/media/[id]">) {
  return handleRoute(async () => {
    await requireActor(request);
    const { id } = await ctx.params;
    const { data } = await createAdminClient().from("media").select("*").eq("id", id).maybeSingle();
    if (!data) throw new HttpError(404, "Media not found");
    return Response.json(data);
  });
}

const patchSchema = z.object({
  /** 1 = starred (offered to the AI first), -1 = never offered to the AI, 0 = clear. */
  rating: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
  /** Have Claude look at the image again and rewrite its card. */
  describe: z.boolean().optional(),
});

/** PATCH /api/media/:id — rate a library image for the AI, or have its card rewritten. Any team member. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/media/[id]">) {
  return handleRoute(async () => {
    await requireActor(request);
    const { id } = await ctx.params;
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Invalid body", parsed.error.issues);
    const admin = createAdminClient();
    const { data } = await admin.from("media").select("*").eq("id", id).maybeSingle();
    const media = data as Media | null;
    if (!media) throw new HttpError(404, "Media not found");
    if (parsed.data.rating != null) await admin.from("media").update({ rating: parsed.data.rating }).eq("id", id);
    if (parsed.data.describe) {
      if (media.type !== "image") throw new HttpError(422, "Only images get a card");
      await describeMedia(media);
    }
    const { data: fresh } = await admin.from("media").select("*").eq("id", id).single();
    return Response.json(fresh);
  });
}

/** DELETE /api/media/:id — uploader or admin. Generated outputs are deleted via /api/generate/:id. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/media/[id]">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { id } = await ctx.params;
    const admin = createAdminClient();
    const { data } = await admin.from("media").select("*").eq("id", id).maybeSingle();
    const media = data as Media | null;
    if (!media) throw new HttpError(404, "Media not found");
    if (!actor.isAdmin && media.user_id !== actor.profile.id) throw new HttpError(403, "Only the uploader or an admin can delete this");
    if (media.generation_id) throw new HttpError(409, "This is a generated output — delete the generation instead");
    await removeStorageObject("media", media.storage_path);
    await admin.from("media").delete().eq("id", id);
    return Response.json({ deleted: true, id });
  });
}

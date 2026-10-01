import { handleRoute, HttpError, requireActor } from "@/lib/auth";
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

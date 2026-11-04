import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

const schema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  media_id: z.string().uuid().nullable().optional(),
  base_prompt: z.string().max(4000).optional(),
  is_default: z.boolean().optional(),
});

/** PATCH /api/subjects/:id */
export async function PATCH(request: Request, ctx: RouteContext<"/api/subjects/[subjectId]">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { subjectId } = await ctx.params;
    const admin = createAdminClient();
    const { data: existing } = await admin.from("subjects").select("user_id").eq("id", subjectId).maybeSingle();
    if (!existing) throw new HttpError(404, "Subject not found");
    if (!actor.isAdmin && existing.user_id !== actor.profile.id) throw new HttpError(403, "Only the creator or an admin can edit this subject");
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Invalid subject", parsed.error.issues);
    if (parsed.data.is_default) await admin.from("subjects").update({ is_default: false }).eq("is_default", true);
    const { data, error } = await admin.from("subjects").update(parsed.data).eq("id", subjectId).select("*, media:media(*)").single();
    if (error) throw new HttpError(500, error.message);
    return Response.json(data);
  });
}

/** DELETE /api/subjects/:id */
export async function DELETE(request: Request, ctx: RouteContext<"/api/subjects/[subjectId]">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { subjectId } = await ctx.params;
    const admin = createAdminClient();
    const { data: existing } = await admin.from("subjects").select("user_id").eq("id", subjectId).maybeSingle();
    if (!existing) throw new HttpError(404, "Subject not found");
    if (!actor.isAdmin && existing.user_id !== actor.profile.id) throw new HttpError(403, "Only the creator or an admin can delete this subject");
    const { error } = await admin.from("subjects").delete().eq("id", subjectId);
    if (error) throw new HttpError(500, error.message);
    return Response.json({ deleted: true, id: subjectId });
  });
}

import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { destroyGeneration } from "@/lib/generations";
import { createAdminClient } from "@/lib/supabase/admin";

async function load(generationId: string) {
  const admin = createAdminClient();
  const { data: take } = await admin.from("starter_takes").select("generation_id, user_id").eq("generation_id", generationId).maybeSingle();
  if (!take) throw new HttpError(404, "Starter take not found");
  return { admin, take };
}

/** PATCH /api/starter/:generationId — { favorite } stars or unstars a take. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/starter/[generationId]">) {
  return handleRoute(async () => {
    await requireActor(request);
    const { generationId } = await ctx.params;
    const parsed = z.object({ favorite: z.boolean() }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Expected { favorite }");
    const { admin } = await load(generationId);
    const { error } = await admin.from("starter_takes").update({ favorite: parsed.data.favorite }).eq("generation_id", generationId);
    if (error) throw new HttpError(500, error.message);
    return Response.json({ ok: true });
  });
}

/** DELETE /api/starter/:generationId — deletes the take and its image for good. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/starter/[generationId]">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { generationId } = await ctx.params;
    const { admin, take } = await load(generationId);
    if (!actor.isAdmin && take.user_id !== actor.profile.id) throw new HttpError(403, "Only the person who made it or an admin can delete it");
    const { data: gen } = await admin.from("generations").select("id, result_storage_path, result_metadata").eq("id", generationId).maybeSingle();
    if (gen) await destroyGeneration(gen);
    else await admin.from("starter_takes").delete().eq("generation_id", generationId);
    return Response.json({ ok: true });
  });
}

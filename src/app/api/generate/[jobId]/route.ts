import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canModify, getGenerationForActor, serializeGeneration, syncGeneration, USER_SELECT } from "@/lib/generations";
import { removeStorageObject } from "@/lib/storage";
import { createAdminClient } from "@/lib/supabase/admin";
import type { GenerationWithUser } from "@/lib/types";

export const maxDuration = 300;

/** GET /api/generate/:jobId — full record; syncs with the provider if still in flight. */
export async function GET(request: Request, ctx: RouteContext<"/api/generate/[jobId]">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { jobId } = await ctx.params;
    const row = await getGenerationForActor(actor, jobId);
    const synced = await syncGeneration(row);
    return Response.json(serializeGeneration({ ...synced, user: row.user }));
  });
}

/** PATCH /api/generate/:jobId — { is_shared } */
export async function PATCH(request: Request, ctx: RouteContext<"/api/generate/[jobId]">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { jobId } = await ctx.params;
    const row = await getGenerationForActor(actor, jobId);
    if (!canModify(actor, row)) throw new HttpError(403, "Only the creator or an admin can change this generation");
    const body = z.object({ is_shared: z.boolean() }).safeParse(await request.json().catch(() => null));
    if (!body.success) throw new HttpError(400, "Expected { is_shared: boolean }");
    const { data } = await createAdminClient()
      .from("generations")
      .update({ is_shared: body.data.is_shared })
      .eq("id", jobId)
      .select(USER_SELECT)
      .single();
    return Response.json(serializeGeneration(data as GenerationWithUser));
  });
}

/** DELETE /api/generate/:jobId — removes the row, its stored output and library entry. Spend history is lost for this row. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/generate/[jobId]">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { jobId } = await ctx.params;
    const row = await getGenerationForActor(actor, jobId);
    if (!canModify(actor, row)) throw new HttpError(403, "Only the creator or an admin can delete this generation");
    const admin = createAdminClient();
    await admin.from("media").delete().eq("generation_id", jobId);
    await removeStorageObject("generations", row.result_storage_path);
    const extraPaths = (row.result_metadata as { additional_storage_paths?: string[] } | null)?.additional_storage_paths ?? [];
    for (const path of extraPaths) await removeStorageObject("generations", path);
    const { error } = await admin.from("generations").delete().eq("id", jobId);
    if (error) throw new HttpError(500, error.message);
    return Response.json({ deleted: true, id: jobId });
  });
}

import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

/** GET /api/subjects — every saved subject lock with its base image. */
export async function GET(request: Request) {
  return handleRoute(async () => {
    await requireActor(request);
    const { data, error } = await createAdminClient().from("subjects").select("*, media:media(*)").order("is_default", { ascending: false }).order("created_at");
    if (error) throw new HttpError(500, error.message);
    return Response.json({ data });
  });
}

const schema = z.object({
  name: z.string().trim().min(1).max(80),
  media_id: z.string().uuid().nullable().optional(),
  base_prompt: z.string().max(4000).default(""),
  is_default: z.boolean().default(false),
});

/** POST /api/subjects — { name, media_id?, base_prompt?, is_default? } */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Invalid subject", parsed.error.issues);
    const admin = createAdminClient();
    if (parsed.data.is_default) await admin.from("subjects").update({ is_default: false }).eq("is_default", true);
    const { data, error } = await admin
      .from("subjects")
      .insert({ ...parsed.data, user_id: actor.profile.id })
      .select("*, media:media(*)")
      .single();
    if (error) throw new HttpError(500, error.message);
    return Response.json(data, { status: 201 });
  });
}

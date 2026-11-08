import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { createAdminClient } from "@/lib/supabase/admin";

/** GET /api/boards — every board, newest first (boards are shared across the team). */
export async function GET(request: Request) {
  return handleRoute(async () => {
    await requireActor(request);
    const { data, error } = await createAdminClient()
      .from("boards")
      .select("id, title, user_id, model, aspect_ratio, created_at, updated_at, user:profiles(id, display_name), beats(count)")
      .order("updated_at", { ascending: false });
    if (error) throw new HttpError(500, error.message);
    return Response.json({ data });
  });
}

const createSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  script: z.string().max(40000).default(""),
  subject_id: z.string().uuid().nullable().optional(),
});

/** POST /api/boards — { title?, script?, subject_id? } */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const parsed = createSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, "Invalid body", parsed.error.issues);
    const settings = await getSettings();
    const admin = createAdminClient();
    // Default to the team's default subject lock when one is marked.
    let subjectId = parsed.data.subject_id ?? null;
    if (subjectId === undefined || subjectId === null) {
      const { data: def } = await admin.from("subjects").select("id").eq("is_default", true).limit(1).maybeSingle();
      subjectId = def?.id ?? null;
    }
    const { data, error } = await admin
      .from("boards")
      .insert({
        user_id: actor.profile.id,
        title: parsed.data.title ?? `Board ${new Date().toLocaleDateString("en-CA")}`,
        script: parsed.data.script,
        subject_id: subjectId,
        model: settings.board_default_model,
        video_model: settings.board_default_video_model,
        avatar_model: settings.board_default_avatar_model,
      })
      .select("*")
      .single();
    if (error) throw new HttpError(500, error.message);
    return Response.json(data, { status: 201 });
  });
}

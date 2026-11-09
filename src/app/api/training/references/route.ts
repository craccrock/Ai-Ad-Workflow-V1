import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { analyzeReference } from "@/lib/reference-edits";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ReferenceEdit } from "@/lib/types";

export const maxDuration = 300;

/** GET /api/training/references — every reference edit, newest first. */
export async function GET(request: Request) {
  return handleRoute(async () => {
    await requireActor(request);
    const { data, error } = await createAdminClient().from("reference_edits").select("*").order("created_at", { ascending: false });
    if (error) throw new HttpError(500, error.message);
    return Response.json({ references: (data ?? []) as ReferenceEdit[] });
  });
}

const bodySchema = z.object({
  media_id: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
});

/**
 * POST /api/training/references — { media_id, title? } registers an uploaded ad as a reference edit and analyses it
 * (scene cuts, presenter vs B-roll per shot, transcript, pacing profile). Synchronous: a 60 s ad takes about a minute.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Invalid body", parsed.error.issues);
    const admin = createAdminClient();
    const { data: media } = await admin.from("media").select("id, url, filename, type").eq("id", parsed.data.media_id).maybeSingle();
    if (!media) throw new HttpError(404, "Upload not found");
    if (media.type !== "video") throw new HttpError(422, "A reference edit has to be a video");
    const { data: row, error } = await admin
      .from("reference_edits")
      .insert({ user_id: actor.profile.id, media_id: media.id, title: parsed.data.title ?? String(media.filename).replace(/\.[^.]+$/, ""), url: media.url, status: "pending" })
      .select("*")
      .single();
    if (error) throw new HttpError(500, error.message);
    const reference = await analyzeReference(row as ReferenceEdit);
    return Response.json({ reference });
  });
}

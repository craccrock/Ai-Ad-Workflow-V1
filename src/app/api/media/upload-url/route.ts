import { randomUUID } from "node:crypto";
import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { extensionFor } from "@/lib/storage";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST /api/media/upload-url — { filename, content_type }
 * Returns a signed URL an API client can PUT a large file to (bypasses the 4.5 MB
 * serverless body limit). Afterwards, register it with POST /api/media { storage_path, ... }.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const body = z
      .object({ filename: z.string().min(1), content_type: z.string().min(3) })
      .safeParse(await request.json().catch(() => null));
    if (!body.success) throw new HttpError(400, "Expected { filename, content_type }");

    const path = `${actor.profile.id}/${randomUUID()}.${extensionFor(body.data.content_type)}`;
    const admin = createAdminClient();
    const { data, error } = await admin.storage.from("media").createSignedUploadUrl(path);
    if (error) throw new HttpError(500, error.message);
    const { data: pub } = admin.storage.from("media").getPublicUrl(path);

    return Response.json({
      storage_path: path,
      upload_url: data.signedUrl,
      token: data.token,
      public_url: pub.publicUrl,
      instructions: "PUT the file bytes to upload_url with the Content-Type header, then POST /api/media with { storage_path, filename, type }.",
    });
  });
}

import "server-only";
import { randomUUID } from "node:crypto";
import { HttpError, type Actor } from "@/lib/auth";
import { IMMUTABLE_CACHE } from "@/lib/cache";
import { extensionFor } from "@/lib/storage";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Media } from "@/lib/types";

const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

export type MediaMetadata = { width?: number; height?: number; duration_seconds?: number; mime_type?: string };

function typeFromMime(mime: string): Media["type"] | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return null;
}

/** Fetch a remote file and store a copy in the team library, so it can be used as a reference. */
export async function importMediaFromUrl(actor: Actor, input: { url: string; filename?: string; metadata?: MediaMetadata }): Promise<Media> {
  const res = await fetch(input.url);
  if (!res.ok) throw new HttpError(400, `Could not fetch url (${res.status})`);
  const mime = res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
  const type = typeFromMime(mime);
  if (!type) throw new HttpError(415, `Unsupported content-type: ${mime}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.byteLength > MAX_IMPORT_BYTES) throw new HttpError(413, "File too large (max 200 MB)");

  const admin = createAdminClient();
  const userId = actor.profile.id;
  const path = `${userId}/${randomUUID()}.${extensionFor(mime)}`;
  const { error: upErr } = await admin.storage.from("media").upload(path, body, { contentType: mime, cacheControl: IMMUTABLE_CACHE });
  if (upErr) throw new HttpError(500, upErr.message);
  const { data: pub } = admin.storage.from("media").getPublicUrl(path);
  const filename = input.filename || decodeURIComponent(new URL(input.url).pathname.split("/").pop() || "import");

  const { data, error } = await admin
    .from("media")
    .insert({
      user_id: userId,
      type,
      filename,
      storage_path: path,
      url: pub.publicUrl,
      file_size_bytes: body.byteLength,
      metadata: { mime_type: mime, ...(input.metadata ?? {}) },
    })
    .select("*")
    .single();
  if (error) throw new HttpError(500, error.message);
  return data as Media;
}

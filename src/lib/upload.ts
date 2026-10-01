"use client";

import { IMMUTABLE_CACHE } from "@/lib/cache";
import { api, type ApiMedia } from "@/lib/client-api";
import { createClient } from "@/lib/supabase/client";
import type { MediaType } from "@/lib/types";

export const ACCEPT: Record<MediaType, string> = {
  image: "image/png,image/jpeg,image/webp",
  audio: "audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4,audio/m4a,audio/x-m4a",
  video: "video/mp4,video/quicktime,video/webm",
};

export function mediaTypeOf(file: File): MediaType | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("video/")) return "video";
  return null;
}

function probe(file: File, type: MediaType): Promise<{ width?: number; height?: number; duration_seconds?: number }> {
  const src = URL.createObjectURL(file);
  const done = <T,>(v: T) => {
    URL.revokeObjectURL(src);
    return v;
  };
  return new Promise((resolve) => {
    if (type === "image") {
      const img = new Image();
      img.onload = () => resolve(done({ width: img.naturalWidth, height: img.naturalHeight }));
      img.onerror = () => resolve(done({}));
      img.src = src;
      return;
    }
    const el = document.createElement(type === "audio" ? "audio" : "video");
    el.preload = "metadata";
    el.onloadedmetadata = () =>
      resolve(
        done({
          duration_seconds: Number.isFinite(el.duration) ? Math.round(el.duration * 100) / 100 : undefined,
          ...(el instanceof HTMLVideoElement ? { width: el.videoWidth, height: el.videoHeight } : {}),
        }),
      );
    el.onerror = () => resolve(done({}));
    el.src = src;
  });
}

/**
 * Uploads straight from the browser to Supabase Storage (skipping Vercel's 4.5 MB body limit),
 * then registers the file in the media library.
 */
export async function uploadMedia(file: File, userId: string): Promise<ApiMedia> {
  const type = mediaTypeOf(file);
  if (!type) throw new Error(`Unsupported file type: ${file.type || file.name}`);
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : type === "image" ? "png" : type === "audio" ? "mp3" : "mp4";
  const path = `${userId}/${crypto.randomUUID()}.${ext}`;

  const [meta, upload] = await Promise.all([
    probe(file, type),
    createClient().storage.from("media").upload(path, file, { contentType: file.type, upsert: false, cacheControl: IMMUTABLE_CACHE }),
  ]);
  if (upload.error) throw new Error(upload.error.message);

  return api<ApiMedia>("/api/media", {
    method: "POST",
    json: { storage_path: path, filename: file.name, type, file_size_bytes: file.size, metadata: { ...meta, mime_type: file.type } },
  });
}

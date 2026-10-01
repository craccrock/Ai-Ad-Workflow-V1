import "server-only";
import { IMMUTABLE_CACHE } from "@/lib/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorMessage } from "@/lib/utils";
import type { ProviderFile } from "@/providers/types";

const EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

export function extensionFor(mime: string) {
  return EXT[mime] ?? mime.split("/")[1]?.split("+")[0] ?? "bin";
}

/** Provider CDNs stall sometimes (Kie's temp host has served 45 KB/s and cut off mid-file). */
const DOWNLOAD_TIMEOUT_MS = 45_000;
const DOWNLOAD_ATTEMPTS = 3;

const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex");
const JPEG_MAGIC = Buffer.from("ffd8ff", "hex");

/**
 * A stalled CDN can end a response early, and Content-Length isn't always honest, so images are
 * checked for their end marker as well. A half-written PNG renders as a band of picture over
 * empty space — which is exactly what reached the gallery before this existed.
 */
export function assertCompleteImage(body: Buffer) {
  if (body.subarray(0, 8).equals(PNG_MAGIC) && !body.subarray(-12).includes(Buffer.from("IEND"))) {
    throw new Error(`Truncated PNG: ${body.byteLength} bytes with no end marker`);
  }
  if (body.subarray(0, 3).equals(JPEG_MAGIC) && !body.subarray(-2).equals(Buffer.from("ffd9", "hex"))) {
    throw new Error(`Truncated JPEG: ${body.byteLength} bytes with no end marker`);
  }
}

/**
 * Downloads a provider's output, with a timeout and a completeness check.
 * A stalled or truncated download must fail rather than hang or store a corrupt file —
 * `finalize` then falls back to the provider's own URL.
 */
async function downloadOutput(url: string, headers?: Record<string, string>): Promise<{ body: Buffer; mimeType: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Failed to download provider output (${res.status})`);
      const body = Buffer.from(await res.arrayBuffer());
      const expected = Number(res.headers.get("content-length") ?? 0);
      if (expected > 0 && body.byteLength !== expected) {
        throw new Error(`Truncated download: got ${body.byteLength} of ${expected} bytes`);
      }
      if (!body.byteLength) throw new Error("Provider returned an empty file");
      assertCompleteImage(body);
      return { body, mimeType: res.headers.get("content-type")?.split(";")[0] || "" };
    } catch (err) {
      lastError = err;
      if (attempt < DOWNLOAD_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw new Error(`Could not download provider output after ${DOWNLOAD_ATTEMPTS} tries: ${errorMessage(lastError)}`);
}

/** Copy a provider output into our `generations` bucket so results never expire. */
/** `suffix` names extra outputs of one job, e.g. Suno's second take → "<id>-2.mp3". */
export async function persistOutputFile(userId: string, generationId: string, file: ProviderFile, suffix = "") {
  let body: Buffer;
  let mimeType = file.mimeType;

  if (file.data) {
    body = file.data;
  } else if (file.url) {
    const downloaded = await downloadOutput(file.url, file.fetchHeaders);
    body = downloaded.body;
    mimeType = downloaded.mimeType || mimeType;
  } else {
    throw new Error("Provider file has neither data nor url");
  }

  // Google URI downloads sometimes come back as octet-stream.
  if (mimeType === "application/octet-stream") mimeType = file.mimeType;

  const path = `${userId}/${generationId}${suffix}.${extensionFor(mimeType)}`;
  const admin = createAdminClient();
  const { error } = await admin.storage.from("generations").upload(path, body, { contentType: mimeType, upsert: true, cacheControl: IMMUTABLE_CACHE });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  const { data } = admin.storage.from("generations").getPublicUrl(path);
  return { path, url: data.publicUrl, mimeType, sizeBytes: body.byteLength };
}

export async function removeStorageObject(bucket: "generations" | "media", path: string | null) {
  if (!path) return;
  await createAdminClient().storage.from(bucket).remove([path]);
}

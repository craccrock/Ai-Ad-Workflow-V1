import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";

/** Longest side Claude needs to judge a frame; also keeps every image well under the API's 5 MB cap. */
const MAX_SIDE = 1280;

/**
 * Fetches an image (e.g. a generation result from Supabase Storage), downsizes it and returns it
 * as a base64 image block for the Messages API. Returns null if the file can't be loaded.
 */
export async function imageBlockFromUrl(url: string): Promise<Anthropic.ImageBlockParam | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const input = Buffer.from(await res.arrayBuffer());
    const data = await sharp(input).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: data.toString("base64") } };
  } catch {
    return null;
  }
}

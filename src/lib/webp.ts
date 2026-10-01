"use client";

/**
 * Converts a finished image to WebP in the browser (canvas), at full resolution.
 * WebP is typically 60–80% smaller than the PNGs the models return, which is what you want
 * on a product page. Originals are never touched — this only affects what gets downloaded.
 */

/** Visually lossless for photos and product shots; well below PNG size. */
export const WEBP_QUALITY = 0.9;

export const webpName = (filename: string) => `${filename.replace(/\.[^./]+$/, "")}.webp`;

/** Re-encodes an image URL as a WebP blob. Throws if the browser can't produce WebP. */
export async function toWebpBlob(url: string, quality = WEBP_QUALITY): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load the image (${res.status})`);
  const bitmap = await createImageBitmap(await res.blob());
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable in this browser");
    ctx.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
    if (!blob || blob.type !== "image/webp") throw new Error("This browser can't save WebP");
    return blob;
  } finally {
    bitmap.close();
  }
}

export function saveBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

export async function downloadAsWebp(url: string, filename: string) {
  saveBlob(await toWebpBlob(url), webpName(filename));
}

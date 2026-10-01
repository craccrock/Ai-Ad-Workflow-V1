"use client";

import { zip, type AsyncZippable } from "fflate";
import { extensionFromUrl } from "@/lib/format";
import { toWebpBlob, webpName } from "@/lib/webp";

export type ZipItem = { url: string; mediaType: string; model: string; prompt?: string | null; createdAt: string };

const slug = (text: string, max = 40) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, max)
    .replace(/-$/, "");

/** e.g. "03-nano-banana-pro-silk-pajamas-on-linen.png" — ordered, readable, unique. */
export function zipFileNames(items: ZipItem[]): string[] {
  const used = new Set<string>();
  return items.map((item, index) => fileNameFor(item, index, used));
}

function fileNameFor(item: ZipItem, index: number, used: Set<string>) {
  const parts = [String(index + 1).padStart(2, "0"), slug(item.model, 28)];
  const promptPart = item.prompt ? slug(item.prompt) : "";
  if (promptPart) parts.push(promptPart);
  const base = parts.join("-");
  const ext = extensionFromUrl(item.url, item.mediaType);
  let name = `${base}.${ext}`;
  let n = 2;
  while (used.has(name)) name = `${base}-${n++}.${ext}`;
  used.add(name);
  return name;
}

/**
 * Downloads the selected outputs and saves them as a single zip, built in the browser.
 * (A server-built zip would hit Vercel's 4.5 MB response limit.)
 */
export async function downloadZip(
  items: ZipItem[],
  zipName: string,
  onProgress?: (done: number, total: number) => void,
  opts: { webp?: boolean } = {},
) {
  const files: AsyncZippable = {};
  const names = zipFileNames(items);

  for (const [index, item] of items.entries()) {
    // Images can be re-encoded as WebP on the way in; anything that won't convert stays as-is.
    if (opts.webp && item.mediaType === "image") {
      try {
        files[webpName(names[index])] = new Uint8Array(await (await toWebpBlob(item.url)).arrayBuffer());
        onProgress?.(index + 1, items.length);
        continue;
      } catch {
        /* fall through to the original file */
      }
    }
    const res = await fetch(item.url);
    if (!res.ok) throw new Error(`Couldn't download ${item.model} (${res.status})`);
    files[names[index]] = new Uint8Array(await res.arrayBuffer());
    onProgress?.(index + 1, items.length);
  }

  const zipped = await new Promise<Uint8Array>((resolve, reject) =>
    // level 0: images and video are already compressed, so packing beats squeezing.
    zip(files, { level: 0 }, (err, data) => (err ? reject(err) : resolve(data))),
  );

  const blob = new Blob([zipped as unknown as BlobPart], { type: "application/zip" });
  const href = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href, download: zipName });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 20_000);
}

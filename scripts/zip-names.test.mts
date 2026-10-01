/** Filenames inside a bulk-download zip: ordered, readable, unique, right extension. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { zipFileNames, type ZipItem } from "../src/lib/zip.ts";

const item = (over: Partial<ZipItem> = {}): ZipItem => ({
  url: "https://x.supabase.co/storage/v1/object/public/generations/u1/abc.png",
  mediaType: "image",
  model: "Nano Banana Pro",
  prompt: "Silk pajamas on linen, warm light",
  createdAt: "2026-09-15T12:00:00Z",
  ...over,
});

test("names are numbered, slugged and carry the right extension", () => {
  const names = zipFileNames([
    item(),
    item({ model: "Kling 3.0 Pro", mediaType: "video", url: "https://x/y/clip.mp4", prompt: "Ferry deck at golden hour" }),
    item({ prompt: null, model: "Recraft Crisp Upscale" }),
  ]);
  assert.deepEqual(names, [
    "01-nano-banana-pro-silk-pajamas-on-linen-warm-light.png",
    "02-kling-3-0-pro-ferry-deck-at-golden-hour.mp4",
    "03-recraft-crisp-upscale.png",
  ]);
});

test("identical prompts still get unique names (the index prefix keeps them apart)", () => {
  const names = zipFileNames([item(), item(), item()]);
  assert.equal(new Set(names).size, 3);
  assert.equal(names[1].slice(0, 3), "02-");
});

test("odd prompts and unknown extensions stay safe", () => {
  const [name] = zipFileNames([item({ prompt: "  ¿Qué? 50% off!! <script>  ", url: "https://x/y/file", mediaType: "video" })]);
  assert.match(name, /^01-nano-banana-pro-qu-50-off-script\.mp4$/);
});

test("webpName swaps the extension, and only the extension", async () => {
  const { webpName } = await import("../src/lib/webp.ts");
  assert.equal(webpName("01-nano-banana-pro-silk-pajamas.png"), "01-nano-banana-pro-silk-pajamas.webp");
  assert.equal(webpName("madaket-gpt-image-2-ab12cd34.jpg"), "madaket-gpt-image-2-ab12cd34.webp");
  assert.equal(webpName("photo.v2.final.png"), "photo.v2.final.webp");
  assert.equal(webpName("no-extension"), "no-extension.webp");
});

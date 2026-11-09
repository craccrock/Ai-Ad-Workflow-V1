import { bundle } from "@remotion/bundler";
import { ensureBrowser, getVideoMetadata, renderMedia, selectComposition } from "@remotion/renderer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PresetId, Word } from "./remotion/pages";

const here = path.dirname(fileURLToPath(import.meta.url));

let bundlePromise: Promise<string> | null = null;
/** Webpack-bundles the Remotion project once per process; every render reuses it. */
export function getBundle(): Promise<string> {
  bundlePromise ??= (async () => {
    await ensureBrowser();
    const serveUrl = await bundle({ entryPoint: path.join(here, "remotion", "index.ts"), webpackOverride: (c) => c });
    console.log("[worker] remotion bundle ready");
    return serveUrl;
  })();
  return bundlePromise;
}

export type RenderInput = { src: string; words: Word[]; preset: PresetId; onProgress?: (p: number) => void; maxSeconds?: number };

/** Renders the captioned ad to an MP4 file and returns its bytes (and the length). */
export async function renderCaptions({ src, words, preset, onProgress, maxSeconds }: RenderInput): Promise<{ bytes: Buffer; durationS: number; width: number; height: number }> {
  const serveUrl = await getBundle();
  const dir = await mkdtemp(path.join(tmpdir(), "captions-"));
  try {
    // The probe wants a local file; the composition itself streams the URL.
    const local = path.join(dir, "source.mp4");
    const res = await fetch(src, { redirect: "follow" });
    if (!res.ok) throw new Error(`Couldn't download the source video (${res.status})`);
    await writeFile(local, Buffer.from(await res.arrayBuffer()));
    const meta = await getVideoMetadata(local);
    const fps = 30;
    if (!meta.durationInSeconds) throw new Error("Couldn't read the source video length");
    const durationS = Math.min(meta.durationInSeconds, maxSeconds ?? Infinity);
    const inputProps = { src, words, preset };
    const composition = await selectComposition({ serveUrl, id: "captions", inputProps });
    const out = path.join(dir, "captions.mp4");
    await renderMedia({
      serveUrl,
      composition: { ...composition, width: meta.width, height: meta.height, fps, durationInFrames: Math.max(1, Math.round(durationS * fps)) },
      codec: "h264",
      crf: 18,
      inputProps,
      outputLocation: out,
      concurrency: Number(process.env.RENDER_CONCURRENCY ?? 2),
      chromiumOptions: { gl: "angle" },
      onProgress: ({ progress }) => onProgress?.(progress),
    });
    return { bytes: await readFile(out), durationS, width: meta.width, height: meta.height };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

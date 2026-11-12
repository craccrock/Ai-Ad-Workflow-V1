import "server-only";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_CUT_RULES, type CutRules } from "@/config/edit-rules";
import { HttpError } from "@/lib/auth";
import { clipWords } from "@/lib/clip-transcripts";
import { IMMUTABLE_CACHE } from "@/lib/cache";
import { logLearningMany } from "@/lib/learning";
import { createAdminClient } from "@/lib/supabase/admin";
import { removeStorageObject } from "@/lib/storage";
import type { ApiGeneration } from "@/lib/client-api";
import { locateLine } from "@/lib/line-match";
import type { AvatarAssembly, AvatarChunk, Beat, Board, FinalAssembly, TranscriptWord } from "@/lib/types";

/** Supabase Pro allows 5 GB per upload, so quality is the only constraint: 12 Mbps 1080p is more than any ad platform keeps. */
const MAX_VIDEO_KBPS = 12000;
const UPLOAD_CAP_BYTES = 5 * 1024 * 1024 * 1024;

/** The release ffmpeg-static 5.3 ships; the runtime fallback downloads the very same build. */
const FFMPEG_STATIC_RELEASE = "b6.1.1";

async function runnable(bin: string): Promise<boolean> {
  try {
    const { code } = await run(bin, ["-version"], 15_000);
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * ffmpeg, in order: an explicit FFMPEG_PATH (local dev with a system install); the binary ffmpeg-static ships, if
 * it made it into the bundle and runs; a copy downloaded once into /tmp (Vercel sometimes drops or de-executes the
 * 80 MB binary during tracing); finally whatever "ffmpeg" is on PATH.
 */
export async function ffmpegBinary(): Promise<string> {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const mod = (await import("ffmpeg-static")) as unknown as { default?: string | null } | string | null;
    const p = typeof mod === "string" ? mod : (mod?.default ?? null);
    if (p && (await runnable(p))) return p;
  } catch {
    /* fall through */
  }
  if (process.platform === "linux") {
    const cached = path.join(tmpdir(), `ffmpeg-${FFMPEG_STATIC_RELEASE}-${process.arch}`);
    if (await runnable(cached)) return cached;
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_RELEASE}/ffmpeg-linux-${arch}`;
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(90_000) });
    if (!res.ok) throw new HttpError(500, `ffmpeg is not available in this deployment and the fallback download failed (${res.status})`);
    await writeFile(cached, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
    await chmod(cached, 0o755);
    if (await runnable(cached)) return cached;
    throw new HttpError(500, "ffmpeg is not available in this deployment (downloaded copy would not run)");
  }
  if (await runnable("ffmpeg")) return "ffmpeg";
  throw new HttpError(500, "ffmpeg is not available in this environment");
}

export function run(bin: string, args: string[], timeoutMs = 240_000): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new HttpError(504, "ffmpeg took too long"));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(t);
      reject(new HttpError(500, `Couldn't start ffmpeg: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

/** Duration, frame size and whether there is an audio stream, read from ffmpeg's own probe output. */
/** Size the fallback encode aims for when storage refuses a file as too large (the project-wide cap defaults to 50 MB). */
const FIT_TARGET_BYTES = 46 * 1024 * 1024;

/**
 * Uploads an assembled video. If storage refuses it for size (the project's global upload limit, which is separate
 * from the bucket's own limit), the file is re-encoded once at a bitrate that fits and uploaded again, so a long or
 * 1080p cut still lands. Raising the limit in Supabase > Storage > Settings makes the fallback unnecessary.
 */
async function uploadVideo(bin: string, dir: string, file: string, storagePath: string, duration: number, what: string): Promise<{ url: string; compressedKbps: number | null }> {
  const admin = createAdminClient();
  const put = async (p: string) => admin.storage.from("generations").upload(storagePath, await readFile(p), { contentType: "video/mp4", upsert: true, cacheControl: IMMUTABLE_CACHE });
  let compressedKbps: number | null = null;
  let { error } = await put(file);
  if (error && /maximum allowed size|too large|payload/i.test(error.message)) {
    const audioKbps = 128;
    const kbps = Math.max(600, Math.floor((FIT_TARGET_BYTES * 8) / Math.max(1, duration) / 1000) - audioKbps);
    const fitted = path.join(dir, "fitted.mp4");
    const r = await run(bin, ["-hide_banner", "-y", "-i", file, "-c:v", "libx264", "-preset", "veryfast", "-b:v", `${kbps}k`, "-maxrate", `${Math.round(kbps * 1.15)}k`, "-bufsize", `${kbps * 2}k`, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", `${audioKbps}k`, "-movflags", "+faststart", fitted]);
    if (r.code !== 0) throw new HttpError(500, `${what} is too large for storage, and shrinking it failed: ${lastLine(r.stderr)}`, r.stderr.slice(-600));
    ({ error } = await put(fitted));
    compressedKbps = kbps;
  }
  if (error) throw new HttpError(500, `Storage upload failed: ${error.message}`);
  return { url: admin.storage.from("generations").getPublicUrl(storagePath).data.publicUrl, compressedKbps };
}

export async function probe(bin: string, file: string): Promise<{ duration: number; width: number; height: number; hasAudio: boolean }> {
  const { stderr } = await run(bin, ["-hide_banner", "-i", file, "-f", "null", "-"], 60_000);
  const d = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
  const v = stderr.match(/Video:.*?\s(\d{2,5})x(\d{2,5})/);
  return { duration, width: v ? Number(v[1]) : 0, height: v ? Number(v[2]) : 0, hasAudio: /Stream #\d+:\d+.*Audio:/.test(stderr) };
}

/**
 * Where to cut a talking-head clip so the held pose after the last word is dropped: the start of the trailing
 * silence plus a short breath, never before 1 s, never after the clip's end. Returns the full duration when the
 * clip has no trailing silence (she talks to the end).
 */
async function tailCut(bin: string, file: string, duration: number): Promise<number> {
  const { stderr } = await run(bin, ["-hide_banner", "-i", file, "-af", "silencedetect=noise=-35dB:d=0.3", "-f", "null", "-"], 60_000);
  const starts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  if (!starts.length) return duration;
  const lastStart = starts[starts.length - 1];
  const closed = ends.some((e) => e > lastStart && e < duration - 0.15);
  if (closed) return duration; // the last silence was mid-clip; she speaks again after it
  const cut = lastStart + 0.3;
  return Math.max(1, Math.min(duration, cut));
}

/** The last meaningful line of ffmpeg's stderr (skipping progress lines), for error messages. */
export const lastLine = (stderr: string) =>
  stderr
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\s*(frame=|size=)/.test(l))
    .slice(-1)[0]
    ?.trim()
    .slice(0, 200) ?? "no output";

export async function download(url: string, to: string) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new HttpError(502, `Couldn't download a clip (${res.status})`);
  await writeFile(to, Buffer.from(await res.arrayBuffer()));
}

/**
 * Joins every chunk's clip, in order, into one talking-head track. Each clip is cut right after its last word
 * (trailing-silence detection), normalised to the first clip's frame size at 30 fps, then concatenated with
 * hard cuts and no gaps. The result is uploaded to the generations bucket and recorded on the board.
 */
export async function assembleAroll(board: Board, chunks: AvatarChunk[], gens: Record<string, ApiGeneration>, userId: string, rules: CutRules = DEFAULT_CUT_RULES): Promise<AvatarAssembly> {
  const ordered = [...chunks].sort((a, b) => a.position - b.position);
  const missing = ordered.filter((c) => !(c.generation_id && gens[c.generation_id]?.status === "completed" && gens[c.generation_id]?.result_url));
  if (missing.length) throw new HttpError(422, `${missing.length} chunk${missing.length === 1 ? " has" : "s have"} no finished clip yet (#${missing.map((c) => ordered.indexOf(c) + 1).join(", #")})`);
  if (!ordered.length) throw new HttpError(422, "No chunks to assemble");

  const bin = await ffmpegBinary();
  const dir = await mkdtemp(path.join(tmpdir(), "aroll-"));
  try {
    // 1. Download every clip.
    const sources = await Promise.all(
      ordered.map(async (c, i) => {
        const file = path.join(dir, `src-${String(i).padStart(3, "0")}.mp4`);
        await download(gens[c.generation_id!].result_url!, file);
        return file;
      }),
    );

    // 2. Probe the first clip for the target frame, then trim + normalise each clip.
    const first = await probe(bin, sources[0]);
    const width = first.width || 720;
    const height = first.height || 1280;
    // Where each clip gets cut. With a transcript the cut is word-accurate: a hair before her first word to a
    //    hair after her last, so the breath before she starts and the held pose after she finishes both go.
    //    Clips with no words fall back to trailing-silence detection.
    const infos = await Promise.all(sources.map((src, i) => (i === 0 ? Promise.resolve(first) : probe(bin, src))));
    const clipTranscripts = await Promise.all(ordered.map((c, i) => (infos[i].hasAudio ? clipWords(c.generation_id!, gens[c.generation_id!].result_url!) : Promise.resolve([] as TranscriptWord[]))));
    const heads: number[] = [];
    const cuts: number[] = [];
    for (let i = 0; i < sources.length; i++) {
      const w = clipTranscripts[i];
      if (w.length) {
        heads[i] = Math.max(0, w[0].start - rules.head_pad_s);
        cuts[i] = Math.min(infos[i].duration, w[w.length - 1].end + rules.tail_pad_s);
        if (cuts[i] - heads[i] < 0.5) {
          heads[i] = 0;
          cuts[i] = infos[i].duration;
        }
      } else {
        heads[i] = 0;
        cuts[i] = infos[i].hasAudio ? await tailCut(bin, sources[i], infos[i].duration) : infos[i].duration;
      }
    }
    const trims: AvatarAssembly["trims"] = ordered.map((c, i) => ({ chunk_id: c.id, cut_s: Math.round(cuts[i] * 100) / 100, source_s: Math.round(infos[i].duration * 100) / 100, head_s: Math.round(heads[i] * 100) / 100 }));
    const totalSeconds = cuts.reduce((s, c, i) => s + (c - heads[i]), 0);
    // The track's own transcript falls straight out of the clip transcripts, shifted onto the joined timeline.
    const trackWords: TranscriptWord[] = [];
    let offset = 0;
    for (let i = 0; i < sources.length; i++) {
      const len = cuts[i] - heads[i];
      for (const w of clipTranscripts[i]) {
        const start = w.start - heads[i];
        const end = w.end - heads[i];
        if (end <= 0 || start >= len) continue;
        trackWords.push({ text: w.text, start: Math.round((offset + Math.max(0, start)) * 1000) / 1000, end: Math.round((offset + Math.min(len, end)) * 1000) / 1000 });
      }
      offset += len;
    }

    // Quality-first encode: constant quality with a generous ceiling on the bitrate.
    const audioKbps = 160;
    const videoKbps = MAX_VIDEO_KBPS;
    void totalSeconds;
    const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p`;
    const encode = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-maxrate", `${videoKbps}k`, "-bufsize", `${videoKbps * 2}k`, "-pix_fmt", "yuv420p"];
    const parts = sources.map((_, i) => path.join(dir, `part-${String(i).padStart(3, "0")}.mp4`));

    // Encode two clips at a time: the function has ~2 vCPUs, and each x264 run already threads.
    let next = 0;
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        while (next < sources.length) {
          const i = next++;
          const src = sources[i];
          const len = (cuts[i] - heads[i]).toFixed(3);
          const args = infos[i].hasAudio
            ? ["-hide_banner", "-y", "-ss", heads[i].toFixed(3), "-i", src, "-t", len, "-vf", vf, ...encode, "-c:a", "aac", "-b:a", `${audioKbps}k`, "-ar", "48000", "-ac", "2", "-movflags", "+faststart", parts[i]]
            : ["-hide_banner", "-y", "-ss", heads[i].toFixed(3), "-i", src, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", len, "-vf", vf, ...encode, "-c:a", "aac", "-b:a", `${audioKbps}k`, "-shortest", "-movflags", "+faststart", parts[i]];
          const r = await run(bin, args);
          if (r.code !== 0) throw new HttpError(500, `ffmpeg failed on chunk #${i + 1}: ${lastLine(r.stderr)}`, r.stderr.slice(-600));
        }
      }),
    );

    // 3. Concat with stream copy: every part now shares codec, size, fps and audio layout.
    const list = path.join(dir, "list.txt");
    await writeFile(list, parts.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
    const out = path.join(dir, "aroll.mp4");
    const r = await run(bin, ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out]);
    if (r.code !== 0) throw new HttpError(500, `ffmpeg failed to join the clips: ${lastLine(r.stderr)}`, r.stderr.slice(-600));
    const final = await probe(bin, out);
    const body = await readFile(out);
    if (body.byteLength > UPLOAD_CAP_BYTES) throw new HttpError(500, `The assembled track is ${Math.round(body.byteLength / 1048576)} MB, over the storage upload cap`);

    // 4. Upload and record; drop the previous assembly file.
    const storagePath = `assemblies/${board.id}/aroll-${Date.now()}.mp4`;
    const admin = createAdminClient();
    const uploaded = await uploadVideo(bin, dir, out, storagePath, final.duration, "The assembled A-roll");
    const assembly: AvatarAssembly = { url: uploaded.url, compressed_kbps: uploaded.compressedKbps ?? undefined, path: storagePath, duration_s: Math.round(final.duration * 10) / 10, chunk_ids: ordered.map((c) => c.id), trims, words: trackWords.length ? trackWords : undefined, created_at: new Date().toISOString() };
    if (board.avatar_assembly?.path && board.avatar_assembly.path !== storagePath) await removeStorageObject("generations", board.avatar_assembly.path).catch(() => {});
    const { error: upErr } = await admin.from("boards").update({ avatar_assembly: assembly, updated_at: new Date().toISOString() }).eq("id", board.id);
    if (upErr) throw new HttpError(500, upErr.message);
    // Every clip that made the cut is a keeper: its prompt produced something the editor shipped.
    void logLearningMany(
      ordered.map((c, i) => ({
        user_id: userId,
        board_id: board.id,
        kind: "keeper" as const,
        target_type: "chunk" as const,
        target_id: c.id,
        generation_id: c.generation_id,
        model: gens[c.generation_id!].model ?? null,
        prompt: c.video_prompt,
        meta: { vo: c.vo, duration: c.duration, cut_s: trims[i].cut_s, head_s: trims[i].head_s, source_s: trims[i].source_s, spoken: clipTranscripts[i].map((w) => w.text).join(" "), assembly: storagePath, rules },
      })),
    );
    return assembly;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── B-roll over A-roll ───────────────────────────────────────────────────────

const MIN_OVERLAY_SECONDS = 0.8;


/**
 * Lays each B-roll beat's clip over the A-roll track for the stretch where its line is spoken. The line is found
 * in the track's word timestamps; the B-roll is trimmed from its in-point to that window (or its own length, or
 * the beat's cap, whichever is shortest), so a short clip cuts back to her early. Her audio runs underneath
 * untouched. Beats without a clip, with the overlay turned off, or whose line can't be found are skipped and listed.
 */
export async function assembleFinal(board: Board, beats: Beat[], gens: Record<string, ApiGeneration>, words: TranscriptWord[], userId: string, rules: CutRules = DEFAULT_CUT_RULES): Promise<FinalAssembly> {
  const track = board.avatar_assembly;
  if (!track?.url) throw new HttpError(422, "Assemble the A-roll first");
  if (!words.length) throw new HttpError(422, "The A-roll track has no transcript yet");

  // 1. Decide where each B-roll beat goes, walking the script in order.
  type Placement = FinalAssembly["placements"][number] & { url: string };
  const placements: Placement[] = [];
  const skipped: FinalAssembly["skipped"] = [];
  let cursor = 0;
  let lastEnd = 0;
  for (const b of [...beats].sort((a, c) => a.position - c.position)) {
    if (b.role !== "broll") continue;
    if (b.overlay_enabled === false) {
      skipped.push({ beat_id: b.id, reason: "overlay turned off" });
      continue;
    }
    const g = b.video_generation_id ? gens[b.video_generation_id] : null;
    if (!g || g.status !== "completed" || !g.result_url) {
      skipped.push({ beat_id: b.id, reason: "no finished clip" });
      continue;
    }
    const hit = locateLine(b.vo, words, cursor);
    if (!hit) {
      skipped.push({ beat_id: b.id, reason: "line not found in the A-roll" });
      continue;
    }
    cursor = hit.endIdx + 1;
    const start = Math.max(hit.start, lastEnd); // never overlap the previous overlay
    let end = hit.end;
    if (b.overlay_max && Number(b.overlay_max) > 0) end = Math.min(end, start + Number(b.overlay_max));
    if (end - start < MIN_OVERLAY_SECONDS) {
      skipped.push({ beat_id: b.id, reason: "window shorter than 0.8 s" });
      continue;
    }
    placements.push({ beat_id: b.id, generation_id: g.id, start_s: start, end_s: end, in_s: Number(b.overlay_in) || 0, score: Math.round(hit.score * 100) / 100, url: g.result_url });
    lastEnd = end;
  }
  if (!placements.length) throw new HttpError(422, `Nothing to lay over: ${skipped.map((s) => s.reason).filter((v, i, a) => a.indexOf(v) === i).join("; ") || "no B-roll beats"}`);

  const bin = await ffmpegBinary();
  const dir = await mkdtemp(path.join(tmpdir(), "final-"));
  try {
    // 2. Download the A-roll and every placed clip.
    const base = path.join(dir, "aroll.mp4");
    await download(track.url, base);
    const info = await probe(bin, base);
    const width = info.width || 720;
    const height = info.height || 1280;
    const srcs = await Promise.all(
      placements.map(async (p, i) => {
        const f = path.join(dir, `b-${String(i).padStart(3, "0")}.mp4`);
        await download(p.url, f);
        return f;
      }),
    );

    // 3. Pace the cut like an editor would. Each clip was placed on its own line; left like that the ad flips to
    //    B-roll for two seconds, back to her for half a second, and off again. So: a B-roll run carries through any
    //    gap shorter than rules.min_return_s into the next clip (neighbouring B-roll lines become one continuous
    //    stretch), every clip shows for at least rules.min_broll_s, and when we do cut back to her she gets at least
    //    rules.min_return_s on camera. All of it limited by how much footage each clip actually has past its in-point.
    const clipInfos = await Promise.all(srcs.map((f) => probe(bin, f)));
    const avail = placements.map((p, i) => Math.max(0, clipInfos[i].duration - p.in_s));
    const lineEnd = placements.map((p) => p.end_s); // the spoken window, before pacing
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      const nxt = placements[i + 1];
      const limit = nxt ? nxt.start_s : info.duration;
      let end = Math.max(lineEnd[i], p.start_s + rules.min_broll_s);
      if (limit - end < rules.min_return_s) end = limit; // too short a return to her: carry through
      p.end_s = Math.min(end, p.start_s + avail[i], limit);
      if (nxt && nxt.start_s - p.end_s > 0 && nxt.start_s - p.end_s < rules.min_return_s) {
        // This clip ran out before the next one starts: bring the next one in early to close the gap.
        const need = lineEnd[i + 1] - p.end_s;
        if (need <= avail[i + 1]) nxt.start_s = p.end_s;
        else nxt.start_s = Math.max(p.end_s, lineEnd[i + 1] - avail[i + 1]);
      }
    }

    // Trim each B-roll to its paced window (from its in-point) and normalise to the A-roll frame.
    const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p`;
    const parts: string[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        while (next < srcs.length) {
          const i = next++;
          const p = placements[i];
          const dur = Math.min(p.end_s - p.start_s, avail[i]);
          if (dur < MIN_OVERLAY_SECONDS) {
            p.end_s = p.start_s; // marks it empty; dropped below
            continue;
          }
          p.end_s = p.start_s + dur;
          const out = path.join(dir, `p-${String(i).padStart(3, "0")}.mp4`);
          const r = await run(bin, ["-hide_banner", "-y", "-ss", p.in_s.toFixed(3), "-i", srcs[i], "-t", dur.toFixed(3), "-an", "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", out]);
          if (r.code !== 0) throw new HttpError(500, `ffmpeg failed trimming B-roll #${i + 1}: ${lastLine(r.stderr)}`, r.stderr.slice(-600));
          parts[i] = out;
        }
      }),
    );
    const live = placements.map((p, i) => ({ p, part: parts[i] })).filter(({ p, part }) => part && p.end_s > p.start_s);
    for (const p of placements) if (p.end_s <= p.start_s) skipped.push({ beat_id: p.beat_id, reason: "clip too short after its in-point" });
    if (!live.length) throw new HttpError(422, "Every B-roll clip was too short after its in-point");

    // 4. Build the finished picture as a chain of hard cuts, one small ffmpeg run per piece: the A-roll between
    //    overlays, then the B-roll part, and so on. Each run decodes one input, so memory stays flat no matter how
    //    many clips there are (one overlay pass with every clip open at once ran the function out of memory).
    const enc = ["-an", "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-maxrate", `${MAX_VIDEO_KBPS}k`, "-bufsize", `${MAX_VIDEO_KBPS * 2}k`, "-pix_fmt", "yuv420p"];
    const pieces: string[] = [];
    const gaps: { from: number; to: number; out: string }[] = [];
    let at = 0;
    live.forEach(({ p, part }, i) => {
      if (p.start_s - at > 0.04) {
        const out = path.join(dir, `a-${String(i).padStart(3, "0")}.mp4`);
        gaps.push({ from: at, to: p.start_s, out });
        pieces.push(out);
      }
      pieces.push(part);
      at = p.end_s;
    });
    if (info.duration - at > 0.04) {
      const out = path.join(dir, "a-tail.mp4");
      gaps.push({ from: at, to: info.duration, out });
      pieces.push(out);
    }
    for (const g of gaps) {
      const r = await run(bin, ["-hide_banner", "-y", "-ss", g.from.toFixed(3), "-i", base, "-t", (g.to - g.from).toFixed(3), ...enc, g.out]);
      if (r.code !== 0) throw new HttpError(500, `ffmpeg failed cutting the A-roll at ${g.from.toFixed(1)}s: ${lastLine(r.stderr)}`, r.stderr.slice(-600));
    }

    // 5. Join the pieces with stream copy, then put her untouched audio back under the picture.
    const list = path.join(dir, "final-list.txt");
    await writeFile(list, pieces.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
    const video = path.join(dir, "final-video.mp4");
    const joined = await run(bin, ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", video]);
    if (joined.code !== 0) throw new HttpError(500, `ffmpeg failed joining the cut: ${lastLine(joined.stderr)}`, joined.stderr.slice(-600));
    const out = path.join(dir, "final.mp4");
    const r = await run(bin, ["-hide_banner", "-y", "-i", video, "-i", base, "-map", "0:v:0", "-map", "1:a?", "-c:v", "copy", "-c:a", "copy", "-shortest", "-movflags", "+faststart", out]);
    if (r.code !== 0) throw new HttpError(500, `ffmpeg failed adding the audio: ${lastLine(r.stderr)}`, r.stderr.slice(-600));
    const final = await probe(bin, out);
    const body = await readFile(out);
    if (body.byteLength > UPLOAD_CAP_BYTES) throw new HttpError(500, `The finished ad is ${Math.round(body.byteLength / 1048576)} MB, over the storage upload cap`);

    // 6. Upload, record, and log every placed B-roll clip as a keeper.
    const storagePath = `assemblies/${board.id}/final-${Date.now()}.mp4`;
    const admin = createAdminClient();
    const uploaded = await uploadVideo(bin, dir, out, storagePath, final.duration, "The finished ad");
    const assembly: FinalAssembly = {
      url: uploaded.url,
      compressed_kbps: uploaded.compressedKbps ?? undefined,
      path: storagePath,
      duration_s: Math.round(final.duration * 10) / 10,
      placements: live.map(({ p }) => ({ beat_id: p.beat_id, generation_id: p.generation_id, start_s: Math.round(p.start_s * 100) / 100, end_s: Math.round(p.end_s * 100) / 100, in_s: p.in_s, score: p.score })),
      skipped,
      created_at: new Date().toISOString(),
    };
    if (board.final_assembly?.path && board.final_assembly.path !== storagePath) await removeStorageObject("generations", board.final_assembly.path).catch(() => {});
    const { error: upErr } = await admin.from("boards").update({ final_assembly: assembly, updated_at: new Date().toISOString() }).eq("id", board.id);
    if (upErr) throw new HttpError(500, upErr.message);
    const byId = new Map(beats.map((b) => [b.id, b]));
    void logLearningMany(
      live.map(({ p }) => ({
        user_id: userId,
        board_id: board.id,
        kind: "keeper" as const,
        target_type: "beat_video" as const,
        target_id: p.beat_id,
        generation_id: p.generation_id,
        model: gens[p.generation_id]?.model ?? null,
        prompt: byId.get(p.beat_id)?.video_prompt ?? null,
        meta: { vo: byId.get(p.beat_id)?.vo, start_s: p.start_s, end_s: p.end_s, in_s: p.in_s, assembly: storagePath, rules },
      })),
    );
    return assembly;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

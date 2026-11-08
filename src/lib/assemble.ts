import "server-only";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpError } from "@/lib/auth";
import { IMMUTABLE_CACHE } from "@/lib/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { removeStorageObject } from "@/lib/storage";
import type { ApiGeneration } from "@/lib/client-api";
import type { AvatarAssembly, AvatarChunk, Board } from "@/lib/types";

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
async function ffmpegBinary(): Promise<string> {
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

function run(bin: string, args: string[], timeoutMs = 240_000): Promise<{ code: number; stderr: string }> {
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
async function probe(bin: string, file: string): Promise<{ duration: number; width: number; height: number; hasAudio: boolean }> {
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
const lastLine = (stderr: string) =>
  stderr
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\s*(frame=|size=)/.test(l))
    .slice(-1)[0]
    ?.trim()
    .slice(0, 200) ?? "no output";

async function download(url: string, to: string) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new HttpError(502, `Couldn't download a clip (${res.status})`);
  await writeFile(to, Buffer.from(await res.arrayBuffer()));
}

/**
 * Joins every chunk's clip, in order, into one talking-head track. Each clip is cut right after its last word
 * (trailing-silence detection), normalised to the first clip's frame size at 30 fps, then concatenated with
 * hard cuts and no gaps. The result is uploaded to the generations bucket and recorded on the board.
 */
export async function assembleAroll(board: Board, chunks: AvatarChunk[], gens: Record<string, ApiGeneration>, userId: string): Promise<AvatarAssembly> {
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
    const trims: AvatarAssembly["trims"] = [];
    const parts: string[] = [];
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      const info = i === 0 ? first : await probe(bin, src);
      const cut = info.hasAudio ? await tailCut(bin, src, info.duration) : info.duration;
      trims.push({ chunk_id: ordered[i].id, cut_s: Math.round(cut * 100) / 100, source_s: Math.round(info.duration * 100) / 100 });
      const out = path.join(dir, `part-${String(i).padStart(3, "0")}.mp4`);
      const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p`;
      const args = info.hasAudio
        ? ["-hide_banner", "-y", "-i", src, "-t", cut.toFixed(3), "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", out]
        : ["-hide_banner", "-y", "-i", src, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", cut.toFixed(3), "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out];
      const r = await run(bin, args);
      if (r.code !== 0) throw new HttpError(500, `ffmpeg failed on chunk #${i + 1}: ${lastLine(r.stderr)}`, r.stderr.slice(-600));
      parts.push(out);
    }

    // 3. Concat with stream copy: every part now shares codec, size, fps and audio layout.
    const list = path.join(dir, "list.txt");
    await writeFile(list, parts.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
    const out = path.join(dir, "aroll.mp4");
    const r = await run(bin, ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out]);
    if (r.code !== 0) throw new HttpError(500, `ffmpeg failed to join the clips: ${lastLine(r.stderr)}`, r.stderr.slice(-600));
    const final = await probe(bin, out);
    const body = await readFile(out);

    // 4. Upload and record; drop the previous assembly file.
    const storagePath = `assemblies/${board.id}/aroll-${Date.now()}.mp4`;
    const admin = createAdminClient();
    const { error } = await admin.storage.from("generations").upload(storagePath, body, { contentType: "video/mp4", upsert: true, cacheControl: IMMUTABLE_CACHE });
    if (error) throw new HttpError(500, `Storage upload failed: ${error.message}`);
    const { data } = admin.storage.from("generations").getPublicUrl(storagePath);
    const assembly: AvatarAssembly = { url: data.publicUrl, path: storagePath, duration_s: Math.round(final.duration * 10) / 10, chunk_ids: ordered.map((c) => c.id), trims, created_at: new Date().toISOString() };
    if (board.avatar_assembly?.path && board.avatar_assembly.path !== storagePath) await removeStorageObject("generations", board.avatar_assembly.path).catch(() => {});
    const { error: upErr } = await admin.from("boards").update({ avatar_assembly: assembly, updated_at: new Date().toISOString() }).eq("id", board.id);
    if (upErr) throw new HttpError(500, upErr.message);
    void userId;
    return assembly;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

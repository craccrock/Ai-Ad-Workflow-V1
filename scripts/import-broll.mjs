#!/usr/bin/env node
/**
 * Imports a sorted B-roll folder tree into the media library as reference stills.
 *   npm run import-broll -- "P:\Loomi bROLL\SK B-roll (Sorted)"
 *
 * For every video a representative frame (30% in, 1280px wide, JPEG) is extracted with ffmpeg and uploaded;
 * images are uploaded as they are. Each row gets `folder` (its sub-folder), `tags` (folder + filename words)
 * and `source_path` (the original file), so re-running only picks up new files.
 * Folders in SKIP are never imported (audio, A-roll, project files).
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";

const exec = promisify(execFile);
const root = process.argv[2];
if (!root) {
  console.error('Usage: npm run import-broll -- "<folder with sub-folders>"');
  process.exit(1);
}
const SKIP = new Set(["talking heads", "music", "sound effects", "voiceovers", "project files & assets"]);
const VIDEO = new Set([".mp4", ".mov", ".webm", ".m4v"]);
const IMAGE = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const CONCURRENCY = 3;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

// Imports are owned by the first admin, so they show under one name in the library.
const { data: owner } = await sb.from("profiles").select("id, display_name").eq("role", "admin").order("created_at").limit(1).maybeSingle();
if (!owner) throw new Error("No admin profile found — run create-admin first");

const { data: existing } = await sb.from("media").select("source_path").not("source_path", "is", null);
const done = new Set((existing ?? []).map((r) => r.source_path));

/** "Cryo - Doctor sprays woman's SK back - 06.mp4" → ["cryo", "doctor", "sprays", "woman's", "sk", "back"] */
function tagsFor(folder, stem) {
  const words = `${folder} ${stem}`
    .toLowerCase()
    .replace(/\(dup\)/g, "")
    .replace(/[-_]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !/^\d+$/.test(w));
  return [...new Set([folder.toLowerCase(), ...words])];
}

async function probeDuration(file) {
  try {
    const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

async function extractFrame(file) {
  const duration = await probeDuration(file);
  const at = Math.max(0.2, duration * 0.3);
  const out = path.join(os.tmpdir(), `broll-${randomUUID()}.jpg`);
  await exec("ffmpeg", ["-v", "error", "-y", "-ss", String(at), "-i", file, "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "3", out]);
  const buf = await fs.readFile(out);
  await fs.unlink(out).catch(() => {});
  return { buf, duration };
}

async function dimensions(file) {
  try {
    const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
    const [w, h] = stdout.trim().split(",").map(Number);
    return { width: w || undefined, height: h || undefined };
  } catch {
    return {};
  }
}

const jobs = [];
for (const entry of await fs.readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || SKIP.has(entry.name.toLowerCase())) continue;
  const folder = entry.name;
  for (const file of await fs.readdir(path.join(root, folder))) {
    const ext = path.extname(file).toLowerCase();
    if (!VIDEO.has(ext) && !IMAGE[ext]) continue;
    const full = path.join(root, folder, file);
    if (done.has(full)) continue;
    jobs.push({ folder, file, full, ext });
  }
}
console.log(`${jobs.length} new files to import (${done.size} already in the library), owner: ${owner.display_name}`);

let ok = 0, failed = 0;
const queue = [...jobs];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const job = queue.shift();
      const stem = path.basename(job.file, job.ext);
      try {
        let buf, mime, meta;
        if (VIDEO.has(job.ext)) {
          const frame = await extractFrame(job.full);
          buf = frame.buf;
          mime = "image/jpeg";
          meta = { mime_type: mime, source_duration_seconds: frame.duration, ...(await dimensions(job.full)) };
        } else {
          buf = await fs.readFile(job.full);
          mime = IMAGE[job.ext];
          meta = { mime_type: mime, ...(await dimensions(job.full)) };
        }
        const storagePath = `${owner.id}/broll/${randomUUID()}.${mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg"}`;
        const { error: upErr } = await sb.storage.from("media").upload(storagePath, buf, { contentType: mime, cacheControl: "31536000" });
        if (upErr) throw new Error(upErr.message);
        const { data: pub } = sb.storage.from("media").getPublicUrl(storagePath);
        const { error } = await sb.from("media").insert({
          user_id: owner.id,
          type: "image",
          filename: stem,
          storage_path: storagePath,
          url: pub.publicUrl,
          file_size_bytes: buf.byteLength,
          metadata: meta,
          folder: job.folder,
          tags: tagsFor(job.folder, stem),
          source_path: job.full,
        });
        if (error) throw new Error(error.message);
        ok++;
        console.log(`✓ ${job.folder} / ${stem}`);
      } catch (err) {
        failed++;
        console.error(`✗ ${job.folder} / ${job.file}: ${err.message}`);
      }
    }
  }),
);
console.log(`done: ${ok} imported, ${failed} failed`);
process.exit(failed ? 1 : 0);

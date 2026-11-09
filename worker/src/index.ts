import { createClient } from "@supabase/supabase-js";
import express from "express";
import { z } from "zod";
import { PRESETS } from "./remotion/pages";
import { getBundle, renderCaptions } from "./render";

/**
 * Affirm Gen Studio render worker. Lives on an always-on box (Railway/Fly/a VPS) because it needs Chrome.
 * The app POSTs a job, gets 202 straight back, and the worker writes progress and the result onto
 * boards.captions in Supabase, which the app polls.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WORKER_SECRET, PORT (optional), RENDER_CONCURRENCY (optional)
 */
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
};
const supabase = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const SECRET = need("WORKER_SECRET");

const app = express();
app.use(express.json({ limit: "20mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, presets: Object.keys(PRESETS) }));

const jobSchema = z.object({
  board_id: z.string().uuid(),
  source_url: z.string().url(),
  words: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })).min(1),
  preset: z.enum(["capcut", "hormozi", "clean"]),
});

// One render at a time: Chrome plus x264 is already using every core.
let running = false;
const queue: (() => Promise<void>)[] = [];
function pump() {
  if (running) return;
  const next = queue.shift();
  if (!next) return;
  running = true;
  void next().finally(() => {
    running = false;
    pump();
  });
}

async function setCaptions(boardId: string, patch: Record<string, unknown>) {
  const { data } = await supabase.from("boards").select("captions").eq("id", boardId).maybeSingle();
  const cur = (data?.captions as Record<string, unknown> | null) ?? {};
  await supabase
    .from("boards")
    .update({ captions: { ...cur, ...patch, updated_at: new Date().toISOString() } })
    .eq("id", boardId);
}

app.post("/render/captions", (req, res) => {
  if (req.header("x-worker-secret") !== SECRET) return res.status(401).json({ error: "bad secret" });
  const parsed = jobSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid job", issues: parsed.error.issues });
  const job = parsed.data;
  queue.push(async () => {
    console.log(`[worker] captions ${job.preset} for board ${job.board_id}`);
    let lastWrite = 0;
    try {
      await setCaptions(job.board_id, { status: "rendering", progress: 0, error: null });
      const { bytes, durationS } = await renderCaptions({
        src: job.source_url,
        words: job.words,
        preset: job.preset,
        onProgress: (p) => {
          const now = Date.now();
          if (now - lastWrite > 3000) {
            lastWrite = now;
            void setCaptions(job.board_id, { progress: Math.round(p * 100) / 100 });
          }
        },
      });
      const storagePath = `assemblies/${job.board_id}/captions-${Date.now()}.mp4`;
      const { error } = await supabase.storage.from("generations").upload(storagePath, bytes, { contentType: "video/mp4", upsert: true, cacheControl: "31536000" });
      if (error) throw new Error(`upload failed: ${error.message}`);
      const { data: pub } = supabase.storage.from("generations").getPublicUrl(storagePath);
      await setCaptions(job.board_id, { status: "ready", progress: 1, url: pub.publicUrl, path: storagePath, duration_s: Math.round(durationS * 10) / 10 });
      console.log(`[worker] done ${storagePath} (${bytes.byteLength} bytes)`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[worker] failed:", message);
      await setCaptions(job.board_id, { status: "failed", error: message.slice(0, 800) });
    }
  });
  res.status(202).json({ queued: true, position: queue.length });
  pump();
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`[worker] listening on :${port}`);
  // Warm the bundle and the browser so the first job doesn't pay for it.
  getBundle().catch((e) => console.error("[worker] bundle failed:", e));
});

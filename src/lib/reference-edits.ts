import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { download, ffmpegBinary, lastLine, probe, run } from "@/lib/assemble";
import { HttpError } from "@/lib/auth";
import { parseBrainJson } from "@/lib/boards";
import { getSettings } from "@/lib/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { transcribeWords } from "@/lib/transcribe";
import type { ReferenceEdit, ReferenceProfile, ReferenceShot, TranscriptWord } from "@/lib/types";

/** Scene-change sensitivity (0–1). 0.3 catches hard cuts in UGC without firing on hand gestures. */
const SCENE_THRESHOLD = 0.3;
/** Shots shorter than this are merged into their neighbour: usually a flash frame or a detector double-fire. */
const MIN_SHOT_S = 0.25;
/** Most frames Claude is shown in one pass; longer edits are sampled by shot length. */
const MAX_FRAMES = 40;

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const stats = (xs: number[]) => ({ count: xs.length, min: r2(Math.min(...(xs.length ? xs : [0]))), median: r2(median(xs)), max: r2(Math.max(...(xs.length ? xs : [0]))) });

/** Hard-cut times (seconds) found by ffmpeg's scene detector, at a reduced frame size for speed. */
async function sceneCuts(bin: string, file: string): Promise<number[]> {
  const { code, stderr } = await run(bin, ["-hide_banner", "-i", file, "-vf", `scale=320:-2,select='gt(scene,${SCENE_THRESHOLD})',showinfo`, "-fps_mode", "vfr", "-f", "null", "-"], 240_000);
  if (code !== 0) throw new HttpError(500, `Scene detection failed: ${lastLine(stderr)}`);
  return [...stderr.matchAll(/pts_time:\s*([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => Number.isFinite(t) && t > 0.05);
}

function shotsFromCuts(cuts: number[], duration: number): { start: number; end: number }[] {
  const bounds = [0, ...cuts.filter((c) => c < duration - 0.05), duration];
  const raw = bounds.slice(1).map((end, i) => ({ start: bounds[i], end }));
  const merged: { start: number; end: number }[] = [];
  for (const s of raw) {
    const prev = merged[merged.length - 1];
    if (prev && (s.end - s.start < MIN_SHOT_S || prev.end - prev.start < MIN_SHOT_S)) prev.end = s.end;
    else merged.push({ ...s });
  }
  return merged;
}

/** Sentences from word timestamps: split on terminal punctuation, falling back to pauses over 0.7 s. */
function sentencesOf(words: TranscriptWord[]): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let cur: TranscriptWord[] = [];
  const flush = () => {
    if (cur.length) out.push({ text: cur.map((w) => w.text).join(" "), start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };
  words.forEach((w, i) => {
    cur.push(w);
    const nxt = words[i + 1];
    if (/[.!?]["”']?$/.test(w.text) || (nxt && nxt.start - w.end > 0.7)) flush();
  });
  flush();
  return out;
}

function buildProfile(shots: ReferenceShot[], words: TranscriptWord[], duration: number): ReferenceProfile {
  const isSpeaker = (k: ReferenceShot["kind"]) => k === "speaker";
  // Runs: consecutive shots of the same side (speaker vs anything else).
  const runs: { on: "speaker" | "broll"; start: number; end: number }[] = [];
  for (const s of shots) {
    const on = isSpeaker(s.kind) ? "speaker" : "broll";
    const prev = runs[runs.length - 1];
    if (prev && prev.on === on) prev.end = s.end;
    else runs.push({ on, start: s.start, end: s.end });
  }
  const len = (r: { start: number; end: number }) => r.end - r.start;
  const brollRuns = runs.filter((r) => r.on === "broll");
  const speakerRuns = runs.filter((r) => r.on === "speaker");
  const returns = speakerRuns.filter((_, i, arr) => !(i === 0 && runs[0]?.on === "speaker") && !(i === arr.length - 1 && runs[runs.length - 1]?.on === "speaker"));
  const speakerTotal = speakerRuns.reduce((s, r) => s + len(r), 0);

  // Lead: for each B-roll run, the nearest word start within 1.5 s; positive = B-roll started before the word.
  const leads: number[] = [];
  for (const r of brollRuns) {
    let best: number | null = null;
    for (const w of words) {
      const d = w.start - r.start;
      if (Math.abs(d) <= 1.5 && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
    if (best !== null) leads.push(best);
  }

  const line_map = sentencesOf(words).map((s) => {
    let onBroll = 0;
    for (const r of brollRuns) onBroll += Math.max(0, Math.min(s.end, r.end) - Math.max(s.start, r.start));
    const share = onBroll / Math.max(0.01, s.end - s.start);
    return { text: s.text, start: r2(s.start), end: r2(s.end), on: share > 0.7 ? ("broll" as const) : share < 0.3 ? ("speaker" as const) : ("mixed" as const) };
  });

  return {
    duration_s: r2(duration),
    shots: shots.length,
    cuts_per_minute: r2(((shots.length - 1) / Math.max(1, duration)) * 60),
    speaker_share: r2(speakerTotal / Math.max(1, duration)),
    broll_share: r2(1 - speakerTotal / Math.max(1, duration)),
    opens_on_speaker_s: runs[0]?.on === "speaker" ? r2(len(runs[0])) : 0,
    closes_on: runs[runs.length - 1]?.on ?? "speaker",
    broll_runs: stats(brollRuns.map(len)),
    speaker_returns: stats(returns.map(len)),
    broll_lead_s: leads.length ? r2(median(leads)) : null,
    line_map,
  };
}

/**
 * Reads a hand-edited ad the way the cutter would need to imitate it: finds every hard cut, shows Claude one frame
 * per shot to tell the presenter from B-roll, transcribes the voice, and turns the result into a pacing profile
 * plus a written description of the style. Updates the reference row as it goes.
 */
export async function analyzeReference(ref: ReferenceEdit): Promise<ReferenceEdit> {
  const admin = createAdminClient();
  const bin = await ffmpegBinary();
  const dir = await mkdtemp(path.join(tmpdir(), "ref-"));
  try {
    const file = path.join(dir, "ref.mp4");
    await download(ref.url, file);
    const info = await probe(bin, file);
    if (!info.duration) throw new HttpError(422, "Couldn't read the video");

    const [cuts, transcript] = await Promise.all([sceneCuts(bin, file), info.hasAudio ? transcribeWords(ref.url).catch(() => ({ words: [] as TranscriptWord[], text: "" })) : Promise.resolve({ words: [] as TranscriptWord[], text: "" })]);
    const spans = shotsFromCuts(cuts, info.duration);

    // One frame per shot (the longest MAX_FRAMES shots if there are more), small, for classification.
    const order = spans.map((s, i) => ({ i, len: s.end - s.start })).sort((a, b) => b.len - a.len).slice(0, MAX_FRAMES).map((x) => x.i).sort((a, b) => a - b);
    const frames: { i: number; data: string }[] = [];
    for (const i of order) {
      const s = spans[i];
      const out = path.join(dir, `shot-${i}.jpg`);
      const mid = (s.start + s.end) / 2;
      const r = await run(bin, ["-hide_banner", "-y", "-ss", mid.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "scale=384:-2", "-q:v", "5", out], 60_000);
      if (r.code === 0) frames.push({ i, data: (await readFile(out)).toString("base64") });
    }
    if (!frames.length) throw new HttpError(500, "Couldn't extract frames from the video");

    const settings = await getSettings();
    const client = new Anthropic();
    const content: Anthropic.ContentBlockParam[] = [];
    for (const f of frames) {
      const s = spans[f.i];
      content.push({ type: "text", text: `Shot ${f.i + 1} (${s.start.toFixed(1)}–${s.end.toFixed(1)}s):` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.data } });
    }
    content.push({
      type: "text",
      text: `These are one frame from each shot of a short-form video ad, in order, with the shot's time range. The transcript of the voice is:\n"""${transcript.text.slice(0, 4000)}"""\n\nFor every shot say whether it is the PRESENTER (the person talking to camera, who appears in several shots) or B-ROLL (anything else: product, hands, locations, screen recordings, stock footage), on-screen TEXT cards, or OTHER. Then describe how this ad is edited as if briefing an editor who must cut the next one the same way: when it leaves the presenter and for what kind of line, how long B-roll runs last, how it opens and closes, anything distinctive. 3–6 sentences, concrete, no praise.\n\nReturn JSON only:\n{"shots":[{"shot":1,"kind":"speaker"|"broll"|"text"|"other","what":"<4–8 words>"}],"style_notes":"..."}`,
    });
    const msg = await client.messages.create({ model: settings.board_brain_model, max_tokens: 4000, messages: [{ role: "user", content }] });
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const out = parseBrainJson(text) as unknown as { shots: { shot: number; kind: ReferenceShot["kind"]; what: string }[]; style_notes: string };
    const kinds = new Map<number, { kind: ReferenceShot["kind"]; what: string }>();
    for (const s of out.shots ?? []) kinds.set(Number(s.shot) - 1, { kind: (["speaker", "broll", "text", "other"] as const).includes(s.kind) ? s.kind : "other", what: String(s.what ?? "").slice(0, 80) });
    // Shots Claude never saw (too short to be sampled) take their nearest classified neighbour's side.
    const shots: ReferenceShot[] = spans.map((s, i) => {
      let k = kinds.get(i);
      for (let d = 1; !k && d < spans.length; d++) k = kinds.get(i - d) ?? kinds.get(i + d);
      return { i, start: r2(s.start), end: r2(s.end), kind: k?.kind ?? "other", what: k?.what ?? "" };
    });

    const profile = buildProfile(shots, transcript.words, info.duration);
    const summary = String(out.style_notes ?? "").trim();
    const { data, error } = await admin.from("reference_edits").update({ status: "ready", error: null, duration_s: r2(info.duration), words: transcript.words, shots, profile, summary }).eq("id", ref.id).select("*").single();
    if (error) throw new HttpError(500, error.message);
    return data as ReferenceEdit;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await admin.from("reference_edits").update({ status: "failed", error: message.slice(0, 500) }).eq("id", ref.id);
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** One paragraph of the style guide, written from a reference's profile and Claude's notes. */
export function referenceGuideParagraph(ref: ReferenceEdit): string {
  const p = ref.profile;
  if (!p) return "";
  const nums = [
    `opens on the presenter for ${p.opens_on_speaker_s}s`,
    `${Math.round(p.broll_share * 100)}% of the runtime is B-roll in ${p.broll_runs.count} runs of ${p.broll_runs.min}–${p.broll_runs.max}s (median ${p.broll_runs.median}s)`,
    p.speaker_returns.count ? `cuts back to the presenter ${p.speaker_returns.count} times for ${p.speaker_returns.min}–${p.speaker_returns.max}s` : "never cuts back to the presenter mid-ad",
    p.broll_lead_s != null ? `B-roll ${p.broll_lead_s >= 0 ? "leads" : "trails"} its line by about ${Math.abs(p.broll_lead_s)}s` : null,
    `${p.cuts_per_minute} cuts per minute`,
    `closes on ${p.closes_on === "speaker" ? "the presenter" : "B-roll"}`,
  ].filter(Boolean);
  return `Reference "${ref.title}": ${ref.summary ?? ""} In numbers: ${nums.join("; ")}.`;
}

import "server-only";
import { HttpError } from "@/lib/auth";
import { env } from "@/lib/env";
import type { TranscriptWord } from "@/lib/types";

type ScribeResponse = { text?: string; words?: { text: string; start: number; end: number; type: "word" | "spacing" | "audio_event" }[] };

/**
 * Word-level timestamps for a video/audio file via ElevenLabs Scribe. Costs a few cents per minute, so callers
 * cache the result (the A-roll track stores its words). Returns only real words, in order.
 */
export async function transcribeWords(fileUrl: string): Promise<{ words: TranscriptWord[]; text: string }> {
  const src = await fetch(fileUrl, { redirect: "follow", signal: AbortSignal.timeout(90_000) });
  if (!src.ok) throw new HttpError(502, `Couldn't download the track to transcribe (${src.status})`);
  const blob = new Blob([await src.arrayBuffer()], { type: "video/mp4" });

  const form = new FormData();
  form.append("model_id", "scribe_v1");
  form.append("file", blob, "track.mp4");
  form.append("timestamps_granularity", "word");
  form.append("language_code", "en");
  form.append("diarize", "false");
  form.append("tag_audio_events", "false");

  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": env.elevenLabsApiKey }, body: form, signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new HttpError(502, `Transcription failed (${res.status})`, (await res.text()).slice(0, 400));
  const data = (await res.json()) as ScribeResponse;
  const words = (data.words ?? []).filter((w) => w.type === "word" && w.text.trim()).map((w) => ({ text: w.text.trim(), start: Math.round(w.start * 1000) / 1000, end: Math.round(w.end * 1000) / 1000 }));
  if (!words.length) throw new HttpError(502, "Transcription returned no words");
  return { words, text: data.text ?? words.map((w) => w.text).join(" ") };
}

// ─── matching a line to the transcript ───────────────────────────────────────

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

/** Loose token equality: exact, or a shared 4-letter prefix (handles -s/-ed/-ing and small transcription slips). */
function same(a: string, b: string) {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4)) return true;
  return false;
}

/** Fraction of `line` tokens found, in order, inside `window` (greedy subsequence match). */
function coverage(line: string[], window: string[]) {
  let j = 0;
  let hits = 0;
  for (const t of line) {
    while (j < window.length && !same(t, window[j])) j++;
    if (j < window.length) {
      hits++;
      j++;
    }
  }
  return hits / Math.max(1, line.length);
}

/**
 * Finds where a line is spoken: the transcript window (starting at or after `fromIndex`) whose words best cover the
 * line's words in order. Returns the word index range and a 0–1 score, or null below the threshold.
 */
export function locateLine(line: string, words: TranscriptWord[], fromIndex = 0, threshold = 0.6): { startIdx: number; endIdx: number; start: number; end: number; score: number } | null {
  const target = norm(line);
  if (!target.length) return null;
  const tokens = words.map((w) => norm(w.text)[0] ?? "");
  const n = target.length;
  let best: { startIdx: number; endIdx: number; score: number } | null = null;
  // Windows a little longer than the line absorb filler words the voice added.
  for (let i = Math.max(0, fromIndex); i < tokens.length; i++) {
    // Anchor: the window should start on a token matching one of the line's first two words.
    if (!same(tokens[i], target[0]) && !(target[1] && same(tokens[i], target[1]))) continue;
    for (const len of [n, Math.ceil(n * 1.15) + 1]) {
      const endIdx = Math.min(tokens.length - 1, i + len - 1);
      const score = coverage(target, tokens.slice(i, endIdx + 1));
      if (!best || score > best.score + 1e-6) best = { startIdx: i, endIdx, score };
    }
    if (best && best.score >= 0.98) break;
  }
  if (!best || best.score < threshold) return null;
  // Tighten the end to the last matched word so trailing filler isn't covered.
  let endIdx = best.endIdx;
  const last = target[target.length - 1];
  for (let k = best.endIdx; k >= best.startIdx; k--) {
    if (same(tokens[k], last)) {
      endIdx = k;
      break;
    }
  }
  return { ...best, endIdx, start: words[best.startIdx].start, end: words[endIdx].end };
}

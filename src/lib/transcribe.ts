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

export { locateLine } from "@/lib/line-match";

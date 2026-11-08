/**
 * Shared (client + server) knobs for the Avatar phase: which video models can voice a talking head,
 * and how long a clip needs to be for a given line.
 */

/** Models that generate speech natively from an image + a line of dialogue, in the order the picker shows them. */
export const AVATAR_MODEL_IDS = [
  "gemini-omni-1.1-flash", // the default: 4/6/8/10 s, native voice, cheapest per talking-head clip
  "seedance-2.5", // for later — Seedance takes a different prompt shape (see board-avatar-prompt.ts notes); 5–30 s
  "seedance-2",
  "seedance-2-fast",
] as const;

export const DEFAULT_AVATAR_MODEL = AVATAR_MODEL_IDS[0];

/** Brisk natural UGC delivery lands around 2.6 words per second; leave ~1 s so the line finishes before the cut. */
export const AVATAR_WORDS_PER_SECOND = 2.6;
export const AVATAR_TAIL_SECONDS = 1;

export const wordCount = (s: string | null | undefined) => (s ?? "").trim().split(/\s+/).filter(Boolean).length;

/** Smallest clip length the model offers that fits the line; the longest one if nothing does. */
export function avatarDurationFor(words: number, durations: readonly number[] | undefined): number {
  const need = words / AVATAR_WORDS_PER_SECOND + AVATAR_TAIL_SECONDS;
  if (!durations?.length) return Math.max(4, Math.ceil(need));
  const sorted = [...durations].sort((a, b) => a - b);
  return sorted.find((d) => d >= need) ?? sorted[sorted.length - 1];
}

/** The most words a line can carry at the model's longest clip length. */
export function maxAvatarWords(durations: readonly number[] | undefined): number {
  const longest = durations?.length ? Math.max(...durations) : 10;
  return Math.floor((longest - AVATAR_TAIL_SECONDS) * AVATAR_WORDS_PER_SECOND);
}

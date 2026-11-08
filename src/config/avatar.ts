/**
 * Shared (client + server) knobs for the Avatar phase: which video models can voice a talking head,
 * how long a line takes to say, and how the script is packed into clips.
 */

/** Models that generate speech natively from an image + a line of dialogue, in the order the picker shows them. */
export const AVATAR_MODEL_IDS = [
  "gemini-omni-1.1-flash", // the default: 4/6/8/10 s, native voice, cheapest per talking-head clip
  "seedance-2.5", // for later — Seedance takes a different prompt shape (see board-avatar-prompt.ts notes); 5–30 s
  "seedance-2",
  "seedance-2-fast",
] as const;

export const DEFAULT_AVATAR_MODEL = AVATAR_MODEL_IDS[0];

/**
 * Speaking pace, calibrated on Daniel reading the script in quick UGC delivery (Nov 8 2026):
 * 36 words / 53 syllables in 9.17 s and 31 words / 46 syllables in 7.89 s → 5.8 syllables/s (≈3.9 words/s) both times.
 * Syllables beat words because medical terms ("seborrheic keratosis") are long.
 */
export const AVATAR_SYLLABLES_PER_SECOND = 5.8;
/** Breath before the first word plus a beat after the last one, so the line lands inside the clip. */
export const AVATAR_TAIL_SECONDS = 0.6;

export const wordCount = (s: string | null | undefined) => (s ?? "").trim().split(/\s+/).filter(Boolean).length;

/** Heuristic English syllable count for one word (vowel groups, silent e, -le, -ed/-es endings). Numbers count per digit. */
export function syllablesInWord(raw: string): number {
  const w = raw.toLowerCase().replace(/[^a-z0-9']/g, "");
  if (!w) return 0;
  if (/^\d+$/.test(w)) return Math.max(1, w.length); // "60" → "sixty" ≈ 2
  if (w.length <= 3) return 1;
  let s = w.replace(/'s$/, "").replace(/'/g, "");
  s = s.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, ""); // silent endings: -es, -ed, -e (but keep -le)
  s = s.replace(/^y/, "");
  const groups = s.match(/[aeiouy]{1,2}/g)?.length ?? 1;
  let n = groups;
  if (/[^aeiouy]le$/.test(w)) n += 1; // peo-ple, ta-ble
  if (/i[aeo]/.test(w) && !/tion|sion/.test(w)) n += 1; // seb-or-rhe-ic, u-re-a style hiatus
  if (/[aeiou]ing$/.test(w) && !/[aeiou]{2}ing$/.test(w)) n += 0;
  return Math.max(1, n);
}

export const syllableCount = (s: string | null | undefined) => (s ?? "").trim().split(/\s+/).filter(Boolean).reduce((n, w) => n + syllablesInWord(w), 0);

/** Seconds a line takes to say at UGC pace, including the breath/beat around it. */
export const speechSeconds = (s: string | null | undefined) => syllableCount(s) / AVATAR_SYLLABLES_PER_SECOND + AVATAR_TAIL_SECONDS;

/** Smallest clip length the model offers that fits the line; the longest one if nothing does. */
export function avatarDurationFor(text: string | null | undefined, durations: readonly number[] | undefined): number {
  const need = speechSeconds(text);
  if (!durations?.length) return Math.max(4, Math.ceil(need));
  const sorted = [...durations].sort((a, b) => a - b);
  return sorted.find((d) => d >= need) ?? sorted[sorted.length - 1];
}

/** True when the line can't be said inside the model's longest clip. */
export function lineTooLong(text: string | null | undefined, durations: readonly number[] | undefined): boolean {
  const longest = durations?.length ? Math.max(...durations) : 10;
  return speechSeconds(text) > longest;
}

// ─── packing the script into clips ───────────────────────────────────────────

/** Sentences, keeping the terminal punctuation; "!" / "?" / "." / "…" end a sentence. */
function sentences(text: string): string[] {
  return (text.replace(/\s+/g, " ").trim().match(/[^.!?…]+(?:[.!?…]+["”’)]*|$)/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

/** Clause breaks inside a sentence, used only when a sentence alone won't fit one clip. */
function clauses(sentence: string): string[] {
  const parts = sentence.split(/(?<=[,;:])\s+|\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [sentence];
}

function splitByWords(text: string, maxSeconds: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur: string[] = [];
  for (const w of words) {
    if (cur.length && speechSeconds([...cur, w].join(" ")) > maxSeconds) {
      out.push(cur.join(" "));
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur.join(" "));
  return out;
}

/**
 * Packs a paragraph into as FEW clips as possible: whole sentences are added to the current chunk until the next one
 * would not fit the longest clip; a sentence that alone exceeds it is split at clause breaks, then by words.
 * Words are never changed or reordered.
 */
export function packParagraph(paragraph: string, durations: readonly number[] | undefined): string[] {
  const maxSeconds = durations?.length ? Math.max(...durations) : 10;
  const units: string[] = [];
  for (const s of sentences(paragraph)) {
    if (speechSeconds(s) <= maxSeconds) units.push(s);
    else for (const c of clauses(s)) units.push(...(speechSeconds(c) <= maxSeconds ? [c] : splitByWords(c, maxSeconds)));
  }
  const chunks: string[] = [];
  let cur = "";
  for (const u of units) {
    const joined = cur ? `${cur} ${u}` : u;
    if (cur && speechSeconds(joined) > maxSeconds) {
      chunks.push(cur);
      cur = u;
    } else cur = joined;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

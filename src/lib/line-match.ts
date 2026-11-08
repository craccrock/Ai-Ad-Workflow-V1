/** Pure helpers for finding where a line is spoken in a word-timestamped transcript (no server imports; unit-testable). */
import type { TranscriptWord } from "@/lib/types";

// ─── matching a line to the transcript ───────────────────────────────────────

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 0–9999 as spoken words ("40" → "forty", "250" → "two hundred fifty"); anything else is left as digits. */
function numberWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 9999) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
  if (n < 1000) return ONES[Math.floor(n / 100)] + " hundred" + (n % 100 ? " " + numberWords(n % 100) : "");
  return ONES[Math.floor(n / 1000)] + " thousand" + (n % 1000 ? " " + numberWords(n % 1000) : "");
}

/**
 * Lowercase word tokens. Numbers and symbols are spelled out the way a transcript writes them ("40%" → "forty
 * percent", "$5" → "five dollars"), so a script line and the spoken words compare like for like.
 */
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/\$\s*(\d[\d,]*)/g, (_, d) => d + " dollars")
    .replace(/(\d[\d,]*)\s*%/g, (_, d) => d + " percent")
    .replace(/\d[\d,]*/g, (d) => numberWords(Number(d.replace(/,/g, ""))))
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

/**
 * Fraction of `line` tokens found, in order, inside `window`. Each token is looked for within the next few
 * transcript words only, so one word the voice changed or dropped costs one hit instead of everything after it.
 */
function coverage(line: string[], window: string[]) {
  let j = 0;
  let hits = 0;
  for (const t of line) {
    let found = -1;
    for (let k = j; k < Math.min(window.length, j + 4); k++) {
      if (same(t, window[k])) {
        found = k;
        break;
      }
    }
    if (found >= 0) {
      hits++;
      j = found + 1;
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

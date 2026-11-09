/** Pure helpers: turn word timestamps into caption "pages" (the groups of words shown together). */

export type Word = { text: string; start: number; end: number };
export type Page = { words: Word[]; start: number; end: number };

export type PresetId = "capcut" | "hormozi" | "clean";

export type PresetSpec = {
  id: PresetId;
  label: string;
  /** Most words on screen at once. */
  maxWords: number;
  /** Longest a page stays up before it must break (seconds). */
  maxSeconds: number;
  /** A pause longer than this breaks the page. */
  breakOnPause: number;
};

export const PRESETS: Record<PresetId, PresetSpec> = {
  capcut: { id: "capcut", label: "CapCut word highlight", maxWords: 4, maxSeconds: 1.6, breakOnPause: 0.45 },
  hormozi: { id: "hormozi", label: "Hormozi big bold", maxWords: 3, maxSeconds: 1.3, breakOnPause: 0.4 },
  clean: { id: "clean", label: "Clean lower third", maxWords: 7, maxSeconds: 3.2, breakOnPause: 0.6 },
};

/** Groups words into pages that never split a sentence end across a page and never outstay their welcome. */
export function paginate(words: Word[], spec: PresetSpec): Page[] {
  const pages: Page[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    pages.push({ words: cur, start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > spec.breakOnPause || cur.length >= spec.maxWords || w.end - cur[0].start > spec.maxSeconds)) flush();
    cur.push(w);
    if (/[.!?]["”']?$/.test(w.text)) flush();
  }
  flush();
  // Each page stays up until the next one starts (no flicker between words), capped so it doesn't linger past a pause.
  for (let i = 0; i < pages.length; i++) {
    const next = pages[i + 1];
    const hold = next ? Math.min(next.start, pages[i].end + 0.6) : pages[i].end + 0.6;
    pages[i].end = Math.max(pages[i].end, hold);
  }
  return pages;
}

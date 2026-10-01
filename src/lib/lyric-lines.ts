/** Suno's aligned words, as Kie returns them (camelCase today; snake_case per its schema). */
export type AlignedWord = { word: string; success?: boolean; startS?: number; endS?: number; start_s?: number; end_s?: number };
export type TimedWord = { word: string; start: number; end: number };
export type TimedLine = { section?: string; text: string; start: number; end: number };

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Words arrive with their line breaks and "[Chorus]" tags attached; turn them into timed lines and sections. */
export function toLines(aligned: AlignedWord[]) {
  const words: TimedWord[] = [];
  const lines: TimedLine[] = [];
  let current: TimedWord[] = [];
  let section: string | undefined;
  let lineSection: string | undefined;

  const flush = () => {
    if (!current.length) return;
    lines.push({ section: lineSection, text: current.map((w) => w.word).join(" "), start: current[0].start, end: current[current.length - 1].end });
    current = [];
  };

  for (const a of aligned) {
    const start = a.startS ?? a.start_s;
    const end = a.endS ?? a.end_s;
    if (start == null || end == null) continue;
    let raw = a.word;
    for (;;) {
      const tag = raw.match(/^\s*\[([^\]]+)\]\s*/);
      if (!tag) break;
      flush();
      section = tag[1].trim();
      raw = raw.slice(tag[0].length);
    }
    if (/^\s*\n/.test(raw)) flush();
    const text = raw.trim();
    if (text) {
      if (!current.length) lineSection = section;
      const w = { word: text, start: round(start), end: round(end) };
      words.push(w);
      current.push(w);
    }
    if (/\n\s*$/.test(raw)) flush();
  }
  flush();
  return { words, lines };
}

/** Editorial tunables for the cutter (A-roll join and B-roll cut). Client + server. */

export type CutRules = {
  /** No B-roll clip shows for less than this (seconds). */
  min_broll_s: number;
  /** When we cut back to the speaker she stays on camera at least this long; shorter gaps are carried through on B-roll. */
  min_return_s: number;
  /** Seconds of picture kept before her first word on each A-roll clip. */
  head_pad_s: number;
  /** Seconds kept after her last word on each A-roll clip (breath room before the hard cut). */
  tail_pad_s: number;
};

export const DEFAULT_CUT_RULES: CutRules = { min_broll_s: 2, min_return_s: 2, head_pad_s: 0.12, tail_pad_s: 0.18 };

export const CUT_RULE_FIELDS: { key: keyof CutRules; label: string; hint: string; min: number; max: number; step: number }[] = [
  { key: "min_broll_s", label: "Min B-roll hold", hint: "No B-roll shorter than this", min: 0.5, max: 10, step: 0.5 },
  { key: "min_return_s", label: "Min time on her", hint: "A cut back to the speaker lasts at least this; shorter gaps stay on B-roll", min: 0.5, max: 10, step: 0.5 },
  { key: "head_pad_s", label: "Before first word", hint: "Picture kept before she starts each clip", min: 0, max: 1, step: 0.02 },
  { key: "tail_pad_s", label: "After last word", hint: "Breath room after she finishes each clip", min: 0, max: 1.5, step: 0.02 },
];

/** Free-text style guide the editor brain reads when planning a cut; the notes box appends to it over time. */
export const DEFAULT_EDIT_RULES = `UGC talking-head ad with B-roll inserts. Hard cuts only, no transitions, no dead air.
Open on her for the hook. Go to B-roll when the line is about a thing (product, body part, place, process), stay on her when the line is about her or a direct address to the viewer.
A B-roll run should carry through neighbouring B-roll lines as one stretch; never flash a clip for under two seconds and never cut back to her for under two seconds.
End on her for the call to action unless the last line is about the product.`;

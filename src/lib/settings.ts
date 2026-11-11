import "server-only";
import { DEFAULT_AVATAR_MODEL } from "@/config/avatar";
import { DEFAULT_AVATAR_PROMPT, DEFAULT_PRONUNCIATIONS } from "@/config/board-avatar-prompt";
import { DEFAULT_BRAIN_PROMPT } from "@/config/board-brain-prompt";
import { DEFAULT_CUT_RULES, DEFAULT_EDIT_RULES, type CutRules } from "@/config/edit-rules";
import { DEFAULT_VIDEO_PROMPT } from "@/config/board-video-prompt";
import { createAdminClient } from "@/lib/supabase/admin";

/** Tunables edited under Admin → Settings. Stored one row per key in `app_settings`. */
export type AppSettings = {
  /** System prompt for the beat splitter; {{SUBJECT_LOCK}}, {{LIBRARY_INDEX}}, {{SCRIPT}} are filled in per run. */
  board_brain_prompt: string;
  /** Claude model that runs the splitter. */
  board_brain_model: string;
  /** How many jobs the Generate-all / Animate-all pools keep in flight (Kie caps at 20). */
  board_concurrency: number;
  /** Image model new boards start with. */
  board_default_model: string;
  /** System prompt for the video-prompt writer; {{SUBJECT_LOCK}}, {{STYLE_LOCKS}}, {{BEATS}} are filled in per run. */
  board_video_prompt: string;
  /** Video model new boards start with. */
  board_default_video_model: string;
  /** System prompt for the avatar (A-roll talking-head) writer; {{SUBJECT_LOCK}}, {{DURATIONS}}, {{BEATS}} are filled in per run. */
  board_avatar_prompt: string;
  /** Talking-head video model new boards start with. */
  board_default_avatar_model: string;
  /** One per line, "term = phonetic respelling"; the avatar writer swaps these into the spoken line so the voice model says them right. */
  board_pronunciations: string;
  /** Free-text style guide for the cutter; the notes box under each assembled output appends to it. */
  edit_rules: string;
  /** Pacing knobs the cutter applies. */
  cut_min_broll_s: number;
  cut_min_return_s: number;
  cut_head_pad_s: number;
  cut_tail_pad_s: number;
};

export const DEFAULT_SETTINGS: AppSettings = {
  board_brain_prompt: DEFAULT_BRAIN_PROMPT,
  board_brain_model: "claude-opus-5-5",
  board_concurrency: 20, // Kie runs 20 jobs at once; the pool keeps that many in flight and starts the next as each finishes
  board_default_model: "nano-banana-pro",
  board_video_prompt: DEFAULT_VIDEO_PROMPT,
  board_default_video_model: "gemini-omni-1.2-flash",
  board_avatar_prompt: DEFAULT_AVATAR_PROMPT,
  board_default_avatar_model: DEFAULT_AVATAR_MODEL,
  board_pronunciations: DEFAULT_PRONUNCIATIONS,
  edit_rules: DEFAULT_EDIT_RULES,
  cut_min_broll_s: DEFAULT_CUT_RULES.min_broll_s,
  cut_min_return_s: DEFAULT_CUT_RULES.min_return_s,
  cut_head_pad_s: DEFAULT_CUT_RULES.head_pad_s,
  cut_tail_pad_s: DEFAULT_CUT_RULES.tail_pad_s,
};

/** The cutter's pacing knobs, from settings. */
export function cutRulesFrom(s: AppSettings): CutRules {
  return { min_broll_s: s.cut_min_broll_s, min_return_s: s.cut_min_return_s, head_pad_s: s.cut_head_pad_s, tail_pad_s: s.cut_tail_pad_s };
}

export async function getSettings(): Promise<AppSettings> {
  const { data } = await createAdminClient().from("app_settings").select("key, value");
  const out: AppSettings = { ...DEFAULT_SETTINGS };
  for (const row of data ?? []) {
    if (row.key in out) (out as Record<string, unknown>)[row.key] = row.value;
  }
  return out;
}

export async function setSettings(patch: Partial<AppSettings>, userId: string) {
  const rows = Object.entries(patch).map(([key, value]) => ({ key, value, updated_by: userId, updated_at: new Date().toISOString() }));
  if (!rows.length) return;
  const { error } = await createAdminClient().from("app_settings").upsert(rows, { onConflict: "key" });
  if (error) throw new Error(error.message);
}

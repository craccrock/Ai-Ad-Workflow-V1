import "server-only";
import { DEFAULT_BRAIN_PROMPT } from "@/config/board-brain-prompt";
import { createAdminClient } from "@/lib/supabase/admin";

/** Tunables edited under Admin → Settings. Stored one row per key in `app_settings`. */
export type AppSettings = {
  /** System prompt for the beat splitter; {{SUBJECT_LOCK}}, {{LIBRARY_INDEX}}, {{SCRIPT}} are filled in per run. */
  board_brain_prompt: string;
  /** Claude model that runs the splitter. */
  board_brain_model: string;
  /** How many beats "Generate all" runs at once. */
  board_concurrency: number;
  /** Image model new boards start with. */
  board_default_model: string;
};

export const DEFAULT_SETTINGS: AppSettings = {
  board_brain_prompt: DEFAULT_BRAIN_PROMPT,
  board_brain_model: "claude-opus-5-5",
  board_concurrency: 1,
  board_default_model: "nano-banana-pro",
};

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

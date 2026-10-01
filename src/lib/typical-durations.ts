import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { summarizeDurations, type DurationSample, type TypicalDurations } from "@/lib/job-status";

/**
 * How long each model usually takes, from our own recent history.
 * Kie often reports "waiting" for the whole run (then jumps straight to "success"), so the card
 * can't tell queueing from generating; instead it compares elapsed time with what's typical.
 */
export async function getTypicalDurations(): Promise<TypicalDurations> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await createAdminClient()
    .from("generations")
    .select("model, duration_seconds, created_at, completed_at")
    .eq("status", "completed")
    .eq("provider", "kie")
    .gte("created_at", since)
    .not("completed_at", "is", null)
    .order("created_at", { ascending: false })
    .limit(1000);
  return summarizeDurations((data ?? []) as DurationSample[]);
}

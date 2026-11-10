import "server-only";
import { LEARNING_TAGS, type LearningTag } from "@/config/learning-tags";
import { createAdminClient } from "@/lib/supabase/admin";

export type LearningKind = "reprompt" | "reroll" | "take_delete" | "take_select" | "thumbs_down" | "keeper" | "edit_note" | "thumbs_up";
export type LearningTarget = "beat_image" | "beat_video" | "chunk" | "aroll" | "final";
export const THUMBS_DOWN_TAGS = LEARNING_TAGS.map((t) => t.value) as [LearningTag, ...LearningTag[]];

export type LearningEvent = {
  user_id: string;
  board_id: string | null;
  kind: LearningKind;
  target_type: LearningTarget;
  target_id?: string | null;
  generation_id?: string | null;
  model?: string | null;
  prompt?: string | null;
  after_prompt?: string | null;
  direction?: string | null;
  tag?: string | null;
  note?: string | null;
  meta?: Record<string, unknown>;
};

/**
 * Records one editorial judgment. Fire-and-forget: a logging failure must never break the action that
 * produced it, so errors are swallowed (and printed) rather than thrown.
 */
export async function logLearning(event: LearningEvent): Promise<void> {
  try {
    const { error } = await createAdminClient()
      .from("learning_events")
      .insert({ ...event, meta: event.meta ?? {} });
    if (error) console.error("[learning] insert failed:", error.message);
  } catch (e) {
    console.error("[learning] insert threw:", e instanceof Error ? e.message : e);
  }
}

/** Several judgments at once (e.g. every clip in an assembled track). */
export async function logLearningMany(events: LearningEvent[]): Promise<void> {
  if (!events.length) return;
  try {
    const { error } = await createAdminClient()
      .from("learning_events")
      .insert(events.map((e) => ({ ...e, meta: e.meta ?? {} })));
    if (error) console.error("[learning] bulk insert failed:", error.message);
  } catch (e) {
    console.error("[learning] bulk insert threw:", e instanceof Error ? e.message : e);
  }
}

/** The prompt and model a generation was made with, for attaching to a judgment about it. */
export async function generationSnapshot(generationId: string | null | undefined): Promise<{ prompt: string | null; model: string | null }> {
  if (!generationId) return { prompt: null, model: null };
  const { data } = await createAdminClient().from("generations").select("prompt, model").eq("id", generationId).maybeSingle();
  return { prompt: (data?.prompt as string | null) ?? null, model: (data?.model as string | null) ?? null };
}

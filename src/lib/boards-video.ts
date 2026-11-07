import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { getModel } from "@/config/models.config";
import { HttpError } from "@/lib/auth";
import { parseBrainJson, type BrainOutput } from "@/lib/boards";
import { getSettings } from "@/lib/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Beat, Board, Subject } from "@/lib/types";

/** Effective clip settings for a beat: its overrides, else the board's defaults, clamped to what the model offers. */
export function videoSettingsFor(board: Board, beat: Beat): { model: string; duration: number; resolution?: string } {
  const modelId = beat.video_model ?? board.video_model;
  const model = getModel(modelId);
  const o = model?.options;
  let duration = beat.video_duration ?? board.video_duration;
  if (o?.durations && !o.durations.includes(duration)) duration = o.defaultDuration ?? o.durations[0];
  let resolution = beat.video_resolution ?? board.video_resolution ?? undefined;
  if (o?.resolutions) {
    if (!resolution || !o.resolutions.includes(resolution)) resolution = o.defaultResolution ?? o.resolutions[0];
  } else resolution = undefined;
  return { model: modelId, duration, resolution };
}

type VideoBrainOutput = { beats?: { id?: string; video_prompt?: string }[] };

/**
 * Writes (or rewrites) video prompts for the given beats in one Claude call. `direction` is an optional
 * editor note applied to every beat in the batch (single-beat "reprompt" passes one beat + its direction).
 */
export async function writeVideoPrompts(board: Board, subject: Subject | null, beats: Beat[], direction?: string): Promise<{ prompts: Record<string, string>; usage: { input: number; output: number } }> {
  if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, "ANTHROPIC_API_KEY is not set — add it to the environment to write video prompts");
  if (!beats.length) throw new HttpError(400, "No beats to write video prompts for");

  const settings = await getSettings();
  const brain = (board.brain_output ?? {}) as BrainOutput;
  const subjectLock = subject ? `${subject.name}: ${subject.base_prompt}`.trim() : brain.subject_lock || "(none)";
  const styleLocks = brain.style_locks && Object.keys(brain.style_locks).length ? Object.entries(brain.style_locks).map(([k, v]) => `- ${k}: ${v}`).join("\n") : "(none)";
  const beatLines = beats.map((b) =>
    JSON.stringify({
      id: b.id,
      vo: b.vo,
      role: b.role,
      style: b.style,
      image_prompt: b.image_prompt,
      current_video_prompt: b.video_prompt || undefined,
      direction: direction?.trim() || undefined,
    }),
  );
  const system = settings.board_video_prompt
    .replace("{{SUBJECT_LOCK}}", subjectLock)
    .replace("{{STYLE_LOCKS}}", `\n${styleLocks}`)
    .replace("{{BEATS}}", `\n${beatLines.join("\n")}`);

  const client = new Anthropic();
  const message = await client.messages
    .stream({ model: settings.board_brain_model, max_tokens: 16000, system, messages: [{ role: "user", content: "Produce the JSON for the BEATS above." }] })
    .finalMessage();
  if (message.stop_reason === "refusal") throw new HttpError(502, "The brain declined these beats");
  if (message.stop_reason === "max_tokens") throw new HttpError(502, "Too many beats for one pass — try a smaller batch");
  const text = message.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  const out = parseBrainJson(text) as unknown as VideoBrainOutput;
  const prompts: Record<string, string> = {};
  const wanted = new Set(beats.map((b) => b.id));
  for (const b of out.beats ?? []) {
    if (b.id && wanted.has(b.id) && b.video_prompt?.trim()) prompts[b.id] = b.video_prompt.trim();
  }
  if (!Object.keys(prompts).length) throw new HttpError(502, "The brain returned no video prompts");

  const admin = createAdminClient();
  await Promise.all(Object.entries(prompts).map(([id, video_prompt]) => admin.from("beats").update({ video_prompt }).eq("id", id)));
  await admin.from("boards").update({ updated_at: new Date().toISOString() }).eq("id", board.id);
  return { prompts, usage: { input: message.usage.input_tokens, output: message.usage.output_tokens } };
}

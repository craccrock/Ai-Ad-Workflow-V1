import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { AVATAR_SYLLABLES_PER_SECOND, avatarDurationFor, DEFAULT_AVATAR_MODEL, packParagraph, speechSeconds, wordCount } from "@/config/avatar";
import { getModel } from "@/config/models.config";
import { HttpError } from "@/lib/auth";
import { parseBrainJson, type BrainOutput } from "@/lib/boards";
import { getSettings } from "@/lib/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { imageBlockFromUrl } from "@/lib/vision";
import type { AvatarChunk, Board, BoardWithBeats, Subject } from "@/lib/types";

/** The avatar model for a board, with a fallback for rows written before the avatar columns existed. */
export const avatarModelFor = (board: Pick<Board, "avatar_model">) => board.avatar_model || DEFAULT_AVATAR_MODEL;

/** The still every avatar clip is animated from: the board's avatar image, else the subject's base image. */
export function avatarStillUrl(full: Pick<BoardWithBeats, "avatar_media_id" | "media" | "subject">): string | null {
  const own = full.avatar_media_id ? full.media[full.avatar_media_id]?.url : null;
  return own ?? full.subject?.media?.url ?? null;
}

/** Effective clip settings for a chunk: its length override (else the shortest clip that fits), the board's model and quality. */
export function avatarSettingsFor(board: Board, chunk: Pick<AvatarChunk, "vo" | "duration">): { model: string; duration: number; resolution?: string } {
  const modelId = avatarModelFor(board);
  const o = getModel(modelId)?.options;
  const durations = o?.durations;
  let duration = chunk.duration && (!durations || durations.includes(chunk.duration)) ? chunk.duration : avatarDurationFor(chunk.vo, durations);
  if (durations && !durations.includes(duration)) duration = o?.defaultDuration ?? durations[0];
  let resolution = board.avatar_resolution ?? undefined;
  if (o?.resolutions) {
    if (!resolution || !o.resolutions.includes(resolution)) resolution = o.defaultResolution ?? o.resolutions[0];
  } else resolution = undefined;
  return { model: modelId, duration, resolution };
}

/** A prompt shorter than this is not a written talking-head prompt. */
export const MIN_AVATAR_PROMPT_CHARS = 200;
export const hasAvatarPrompt = (c: Pick<AvatarChunk, "video_prompt">) => (c.video_prompt?.trim().length ?? 0) >= MIN_AVATAR_PROMPT_CHARS;

export async function loadAvatarChunks(boardId: string): Promise<AvatarChunk[]> {
  const { data } = await createAdminClient().from("avatar_chunks").select("*").eq("board_id", boardId).order("position");
  return (data ?? []) as AvatarChunk[];
}

const anthropic = () => {
  if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, "ANTHROPIC_API_KEY is not set — add it to the environment to use the avatar writer");
  return new Anthropic();
};

// ─── chunking ────────────────────────────────────────────────────────────────

/**
 * Cuts the WHOLE script into clip-sized chunks the avatar speaks in order, and replaces the board's chunk list.
 * Deterministic: paragraphs are packed sentence by sentence into as few clips as possible, using the calibrated
 * speaking pace (see config/avatar.ts), so a 9 s pair of lines becomes one 10 s clip, not two. Words are never
 * changed. Falls back to the storyboard beats' lines when the script box is empty.
 */
export async function chunkScript(board: Board, beatLines: string[]): Promise<{ chunks: AvatarChunk[]; usage: { input: number; output: number } }> {
  const model = getModel(avatarModelFor(board));
  const durations = model?.options.durations ?? [4, 6, 8, 10];

  const source = board.script.trim() || beatLines.map((l) => l.trim()).filter(Boolean).join("\n\n");
  if (!source) throw new HttpError(422, "Paste the script first");
  // Line and paragraph breaks in the script are layout, not pauses: the whole script is one stream of sentences,
  // packed into as few clips as will fit, so two short lines on separate lines still share one 10 s clip.
  const stream = source.replace(/\s+/g, " ").trim();
  const rows: Omit<AvatarChunk, "id" | "created_at">[] = [];
  for (const vo of packParagraph(stream, durations)) {
    rows.push({ board_id: board.id, position: rows.length, vo, duration: avatarDurationFor(vo, durations), video_prompt: null, generation_id: null, generation_ids: [] });
  }
  if (!rows.length) throw new HttpError(422, "Nothing to chunk");

  const admin = createAdminClient();
  const { error: delErr } = await admin.from("avatar_chunks").delete().eq("board_id", board.id);
  if (delErr) throw new HttpError(500, delErr.message);
  const { data, error } = await admin.from("avatar_chunks").insert(rows).select("*");
  if (error) throw new HttpError(500, error.message);
  await admin.from("boards").update({ updated_at: new Date().toISOString() }).eq("id", board.id);
  const chunks = ((data ?? []) as AvatarChunk[]).sort((a, b) => a.position - b.position);
  return { chunks, usage: { input: 0, output: 0 } };
}

// ─── prompt writing ──────────────────────────────────────────────────────────

type AvatarBrainOutput = { beats?: { id?: string; video_prompt?: string }[] };

/**
 * Writes (or rewrites) the talking-head prompt for the given chunks in one Claude call, from the avatar still.
 * `direction`/`fresh` apply to every chunk in the batch (a single-chunk reprompt passes one chunk).
 */
export async function writeAvatarPrompts(
  board: Board,
  subject: Subject | null,
  allChunks: AvatarChunk[],
  targets: AvatarChunk[],
  avatarUrl: string,
  opts: { direction?: string; exampleUrls?: string[]; fresh?: boolean } = {},
): Promise<{ prompts: Record<string, string>; usage: { input: number; output: number } }> {
  if (!targets.length) throw new HttpError(400, "No chunks to write prompts for");
  const settings = await getSettings();
  const brain = (board.brain_output ?? {}) as BrainOutput;
  const subjectLock = subject ? `${subject.name}: ${subject.base_prompt}`.trim() : brain.subject_lock || "(describe her from the still)";
  const model = getModel(avatarModelFor(board));
  const durations = model?.options.durations ?? [4, 6, 8, 10];

  const lines = targets.map((c) => {
    const k = allChunks.findIndex((x) => x.id === c.id);
    return JSON.stringify({
      id: c.id,
      vo: c.vo,
      words: wordCount(c.vo),
      speech_seconds_estimate: Math.round(speechSeconds(c.vo) * 10) / 10,
      duration_seconds: avatarSettingsFor(board, c).duration,
      previous_line: k > 0 ? allChunks[k - 1].vo : undefined,
      next_line: k >= 0 && k < allChunks.length - 1 ? allChunks[k + 1].vo : undefined,
      current_video_prompt: opts.fresh ? undefined : c.video_prompt || undefined,
      direction: opts.direction?.trim() || undefined,
      start_from_scratch: opts.fresh || undefined,
    });
  });
  const pronunciations = settings.board_pronunciations.trim() || "(none listed — still respell anything the voice is likely to get wrong)";
  const filled = settings.board_avatar_prompt
    .replace("{{SUBJECT_LOCK}}", subjectLock)
    .replace("{{DURATIONS}}", `${durations.join(", ")} (quick UGC pace: about ${AVATAR_SYLLABLES_PER_SECOND} syllables ≈ 3.9 words per second)`)
    .replace("{{BEATS}}", `\n${lines.join("\n")}`);
  // A custom template saved before the guide existed has no placeholder; append the block so the rule still applies.
  const system = filled.includes("{{PRONUNCIATIONS}}") ? filled.replace("{{PRONUNCIATIONS}}", `\n${pronunciations}`) : `${filled}\n\nPRONUNCIATIONS (respell these inside the quoted line so the voice says them right; CAPITALS = stressed syllable):\n${pronunciations}`;

  const content: Anthropic.ContentBlockParam[] = [];
  const still = await imageBlockFromUrl(avatarUrl);
  if (!still) throw new HttpError(502, "Couldn't load the avatar still to show Claude");
  content.push({ type: "text", text: "AVATAR STILL (the exact frame that gets animated):" }, still);
  let n = 0;
  for (const url of opts.exampleUrls ?? []) {
    const block = await imageBlockFromUrl(url);
    if (block) content.push({ type: "text", text: `EXAMPLE ${++n} from the editor (a look or energy to aim for; describe its qualities in words):` }, block);
  }
  content.push({ type: "text", text: "Produce the JSON for the BEATS." });

  const message = await anthropic()
    .messages.stream({ model: settings.board_brain_model, max_tokens: 24000, system, messages: [{ role: "user", content }] })
    .finalMessage();
  if (message.stop_reason === "refusal") throw new HttpError(502, "The brain declined these chunks");
  if (message.stop_reason === "max_tokens") throw new HttpError(502, "Too many chunks for one pass — try a smaller batch");
  const text = message.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  const out = parseBrainJson(text) as unknown as AvatarBrainOutput;
  const prompts: Record<string, string> = {};
  const wanted = new Set(targets.map((c) => c.id));
  for (const b of out.beats ?? []) {
    if (b.id && wanted.has(b.id) && b.video_prompt?.trim()) prompts[b.id] = b.video_prompt.trim();
  }
  if (!Object.keys(prompts).length) throw new HttpError(502, "The brain returned no avatar prompts");

  const admin = createAdminClient();
  await Promise.all(Object.entries(prompts).map(([id, video_prompt]) => admin.from("avatar_chunks").update({ video_prompt }).eq("id", id)));
  await admin.from("boards").update({ updated_at: new Date().toISOString() }).eq("id", board.id);
  return { prompts, usage: { input: message.usage.input_tokens, output: message.usage.output_tokens } };
}

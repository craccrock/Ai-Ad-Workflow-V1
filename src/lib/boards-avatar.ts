import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { AVATAR_WORDS_PER_SECOND, avatarDurationFor, DEFAULT_AVATAR_MODEL, maxAvatarWords, wordCount } from "@/config/avatar";
import { AVATAR_CHUNK_PROMPT } from "@/config/board-avatar-prompt";
import { getModel } from "@/config/models.config";
import { HttpError } from "@/lib/auth";
import { parseBrainJson, type BrainOutput } from "@/lib/boards";
import { getSettings } from "@/lib/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { imageBlockFromUrl } from "@/lib/vision";
import type { Beat, Board, BoardWithBeats, Subject } from "@/lib/types";

/** The avatar model for a board, with a fallback for rows written before the avatar columns existed. */
export const avatarModelFor = (board: Pick<Board, "avatar_model">) => board.avatar_model || DEFAULT_AVATAR_MODEL;

/** The still every A-roll clip is animated from: the board's avatar image, else the subject's base image. */
export function avatarStillUrl(full: Pick<BoardWithBeats, "avatar_media_id" | "media" | "subject">): string | null {
  const own = full.avatar_media_id ? full.media[full.avatar_media_id]?.url : null;
  return own ?? full.subject?.media?.url ?? null;
}

/** Clip length for an A-roll beat: its override, else the shortest clip that fits its line. */
export function avatarDurationForBeat(board: Pick<Board, "avatar_model">, beat: Pick<Beat, "vo" | "video_duration" | "video_model">): number {
  const model = getModel(beat.video_model ?? avatarModelFor(board));
  const durations = model?.options.durations;
  if (beat.video_duration && (!durations || durations.includes(beat.video_duration))) return beat.video_duration;
  return avatarDurationFor(wordCount(beat.vo), durations);
}

const anthropic = () => {
  if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, "ANTHROPIC_API_KEY is not set — add it to the environment to use the avatar writer");
  return new Anthropic();
};

// ─── chunking ────────────────────────────────────────────────────────────────

type ChunkOutput = { groups?: { group?: number; chunks?: { vo?: string; duration?: number }[] }[] };

/**
 * Re-cuts the board's A-roll narration into clip-sized beats. Consecutive A-roll beats are treated as one stretch
 * of narration (so a cut the splitter made in the wrong place can heal), re-chunked by Claude, and written back in
 * place; B-roll beats are untouched. Returns the full, re-numbered beat list.
 */
export async function chunkAroll(board: Board, beats: Beat[]): Promise<{ beats: Beat[]; usage: { input: number; output: number } }> {
  const model = getModel(avatarModelFor(board));
  const durations = model?.options.durations ?? [4, 6, 8, 10];
  const maxWords = maxAvatarWords(durations);

  // Runs of consecutive A-roll beats, by index.
  const runs: number[][] = [];
  beats.forEach((b, i) => {
    if (b.role !== "aroll" || !b.vo.trim()) return;
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === i - 1) last.push(i);
    else runs.push([i]);
  });
  if (!runs.length) throw new HttpError(422, "No A-roll beats with a line to chunk");

  const groups = runs.map((run, g) => ({ group: g + 1, text: run.map((i) => beats[i].vo.trim()).join(" ") }));
  const system = AVATAR_CHUNK_PROMPT.replace("{{DURATIONS}}", durations.join(", ")).replace(/\{\{MAX_WORDS\}\}/g, String(maxWords)).replace("{{GROUPS}}", `\n${groups.map((g) => JSON.stringify(g)).join("\n")}`);
  const settings = await getSettings();
  const message = await anthropic()
    .messages.stream({ model: settings.board_brain_model, max_tokens: 16000, system, messages: [{ role: "user", content: "Produce the JSON for the GROUPS above." }] })
    .finalMessage();
  if (message.stop_reason === "refusal") throw new HttpError(502, "The brain declined this script");
  if (message.stop_reason === "max_tokens") throw new HttpError(502, "Too much narration for one pass");
  const text = message.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  const out = parseBrainJson(text) as unknown as ChunkOutput;

  // Validate every group came back with its words intact (loosely: same word count ±10%).
  const byGroup = new Map<number, { vo: string; duration: number }[]>();
  for (const g of out.groups ?? []) {
    if (!g.group || !Array.isArray(g.chunks)) continue;
    const chunks = g.chunks.map((c) => ({ vo: (c.vo ?? "").trim(), duration: Number(c.duration) || 0 })).filter((c) => c.vo);
    if (chunks.length) byGroup.set(g.group, chunks);
  }
  for (const g of groups) {
    const chunks = byGroup.get(g.group);
    if (!chunks) throw new HttpError(502, `The brain returned nothing for narration group ${g.group}`);
    const want = wordCount(g.text);
    const got = chunks.reduce((n, c) => n + wordCount(c.vo), 0);
    if (Math.abs(got - want) > Math.max(2, want * 0.1)) throw new HttpError(502, `The brain changed the words in group ${g.group} (${got} vs ${want}) — try again`);
  }

  // Rebuild the list: each run is replaced by its chunks, carrying the run's first beat's style/settings.
  const admin = createAdminClient();
  const removeIds: string[] = [];
  const next: (Beat | Omit<Beat, "id" | "created_at">)[] = [];
  const consumed = new Set<number>();
  runs.forEach((run) => run.forEach((i) => consumed.add(i)));
  beats.forEach((b, i) => {
    if (!consumed.has(i)) return next.push(b);
    const run = runs.find((r) => r[0] === i);
    if (!run) return; // not the first of its run — already replaced
    const src = beats[i];
    run.forEach((j) => removeIds.push(beats[j].id));
    const chunks = byGroup.get(runs.indexOf(run) + 1) ?? [];
    for (const c of chunks) {
      const computed = avatarDurationFor(wordCount(c.vo), durations);
      const duration = durations.includes(c.duration) && c.duration >= computed ? c.duration : computed;
      next.push({
        board_id: board.id,
        position: 0,
        role: "aroll",
        vo: c.vo,
        shot_type: src.shot_type,
        style: src.style,
        image_prompt: "",
        video_prompt: null,
        negative_prompt: null,
        reference_plan: null,
        use_subject_lock: true,
        pose_media_id: null,
        setting_media_id: null,
        extra_media_ids: [],
        generation_id: null,
        generation_ids: [],
        video_model: null,
        video_duration: duration,
        video_resolution: null,
        video_generation_id: null,
        video_generation_ids: [],
      });
    }
  });

  if (removeIds.length) {
    const { error } = await admin.from("beats").delete().in("id", removeIds);
    if (error) throw new HttpError(500, error.message);
  }
  const inserts = next.filter((b): b is Omit<Beat, "id" | "created_at"> => !("id" in b));
  const { data: inserted, error: insErr } = inserts.length ? await admin.from("beats").insert(inserts.map((b, k) => ({ ...b, position: 10000 + k }))).select("*") : { data: [] as Beat[], error: null };
  if (insErr) throw new HttpError(500, insErr.message);
  const queue = [...((inserted ?? []) as Beat[])];
  const final: Beat[] = next.map((b) => ("id" in b ? b : queue.shift()!));
  await Promise.all(final.map((b, position) => admin.from("beats").update({ position }).eq("id", b.id)));
  await admin.from("boards").update({ updated_at: new Date().toISOString() }).eq("id", board.id);
  return { beats: final.map((b, position) => ({ ...b, position })), usage: { input: message.usage.input_tokens, output: message.usage.output_tokens } };
}

// ─── prompt writing ──────────────────────────────────────────────────────────

type AvatarBrainOutput = { beats?: { id?: string; video_prompt?: string }[] };

/**
 * Writes (or rewrites) the talking-head prompt for the given A-roll beats in one Claude call, from the avatar still.
 * `direction`/`fresh` apply to every beat in the batch (single-beat reprompt passes one beat).
 */
export async function writeAvatarPrompts(
  board: Board,
  subject: Subject | null,
  allBeats: Beat[],
  targets: Beat[],
  avatarUrl: string,
  opts: { direction?: string; exampleUrls?: string[]; fresh?: boolean } = {},
): Promise<{ prompts: Record<string, string>; usage: { input: number; output: number } }> {
  if (!targets.length) throw new HttpError(400, "No A-roll beats to write prompts for");
  const settings = await getSettings();
  const brain = (board.brain_output ?? {}) as BrainOutput;
  const subjectLock = subject ? `${subject.name}: ${subject.base_prompt}`.trim() : brain.subject_lock || "(describe her from the still)";
  const model = getModel(avatarModelFor(board));
  const durations = model?.options.durations ?? [4, 6, 8, 10];

  const arollOrder = allBeats.filter((b) => b.role === "aroll");
  const lines = targets.map((b) => {
    const k = arollOrder.findIndex((x) => x.id === b.id);
    return JSON.stringify({
      id: b.id,
      vo: b.vo,
      words: wordCount(b.vo),
      duration_seconds: avatarDurationForBeat(board, b),
      previous_line: k > 0 ? arollOrder[k - 1].vo : undefined,
      next_line: k >= 0 && k < arollOrder.length - 1 ? arollOrder[k + 1].vo : undefined,
      current_video_prompt: opts.fresh ? undefined : b.video_prompt || undefined,
      direction: opts.direction?.trim() || undefined,
      start_from_scratch: opts.fresh || undefined,
    });
  });
  const system = settings.board_avatar_prompt
    .replace("{{SUBJECT_LOCK}}", subjectLock)
    .replace("{{DURATIONS}}", `${durations.join(", ")} (about ${AVATAR_WORDS_PER_SECOND} words per second)`)
    .replace("{{BEATS}}", `\n${lines.join("\n")}`);

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
  if (message.stop_reason === "refusal") throw new HttpError(502, "The brain declined these beats");
  if (message.stop_reason === "max_tokens") throw new HttpError(502, "Too many beats for one pass — try a smaller batch");
  const text = message.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  const out = parseBrainJson(text) as unknown as AvatarBrainOutput;
  const prompts: Record<string, string> = {};
  const wanted = new Set(targets.map((b) => b.id));
  for (const b of out.beats ?? []) {
    if (b.id && wanted.has(b.id) && b.video_prompt?.trim()) prompts[b.id] = b.video_prompt.trim();
  }
  if (!Object.keys(prompts).length) throw new HttpError(502, "The brain returned no avatar prompts");

  const admin = createAdminClient();
  await Promise.all(Object.entries(prompts).map(([id, video_prompt]) => admin.from("beats").update({ video_prompt }).eq("id", id)));
  await admin.from("boards").update({ updated_at: new Date().toISOString() }).eq("id", board.id);
  return { prompts, usage: { input: message.usage.input_tokens, output: message.usage.output_tokens } };
}

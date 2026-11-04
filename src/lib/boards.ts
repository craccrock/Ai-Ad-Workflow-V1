import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { HttpError, type Actor } from "@/lib/auth";
import { serializeGeneration } from "@/lib/generations";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/settings";
import type { Beat, BeatRole, Board, BoardWithBeats, Generation, Media, Subject } from "@/lib/types";

// ─── access ──────────────────────────────────────────────────────────────────

export async function getBoardForActor(actor: Actor, id: string): Promise<Board> {
  const { data } = await createAdminClient().from("boards").select("*").eq("id", id).maybeSingle();
  if (!data) throw new HttpError(404, "Board not found");
  // Boards are shared across the team for reading; only the owner or an admin may change them (checked by callers).
  return data as Board;
}

export function canEditBoard(actor: Actor, board: Pick<Board, "user_id">) {
  return actor.isAdmin || board.user_id === actor.profile.id;
}

export async function loadBoardWithBeats(board: Board): Promise<BoardWithBeats> {
  const admin = createAdminClient();
  const [{ data: beats }, subject] = await Promise.all([
    admin.from("beats").select("*").eq("board_id", board.id).order("position"),
    board.subject_id ? loadSubject(board.subject_id) : Promise.resolve(null),
  ]);
  const list = (beats ?? []) as Beat[];
  const mediaIds = new Set<string>();
  const genIds = new Set<string>();
  for (const b of list) {
    if (b.pose_media_id) mediaIds.add(b.pose_media_id);
    if (b.setting_media_id) mediaIds.add(b.setting_media_id);
    if (b.generation_id) genIds.add(b.generation_id);
  }
  if (subject?.media_id) mediaIds.add(subject.media_id);
  const [{ data: media }, { data: gens }] = await Promise.all([
    mediaIds.size ? admin.from("media").select("*").in("id", [...mediaIds]) : Promise.resolve({ data: [] as Media[] }),
    genIds.size ? admin.from("generations").select("*").in("id", [...genIds]) : Promise.resolve({ data: [] }),
  ]);
  return {
    ...board,
    subject,
    beats: list,
    media: Object.fromEntries(((media ?? []) as Media[]).map((m) => [m.id, m])),
    generations: Object.fromEntries(((gens ?? []) as Generation[]).map((g) => [g.id, serializeGeneration(g)])),
  };
}

export async function loadSubject(id: string): Promise<Subject | null> {
  const { data } = await createAdminClient().from("subjects").select("*, media:media(*)").eq("id", id).maybeSingle();
  return (data as Subject | null) ?? null;
}

// ─── the brain ───────────────────────────────────────────────────────────────

/** "Category / filename" lines for every imported library asset, as the brain prompt expects. */
export async function libraryIndex(): Promise<{ lines: string[]; byKey: Map<string, Media> }> {
  const { data } = await createAdminClient().from("media").select("*").not("folder", "is", null).eq("type", "image").order("folder").order("filename");
  const byKey = new Map<string, Media>();
  const lines: string[] = [];
  for (const m of (data ?? []) as Media[]) {
    const key = `${m.folder} / ${m.filename}`;
    byKey.set(normalizeKey(key), m);
    lines.push(key);
  }
  return { lines, byKey };
}

const normalizeKey = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]{2,4}$/i, "").replace(/\s+/g, " ").trim();

/** Resolve a "Category / filename" the brain wrote back to a library row; tolerant of extensions and spacing. */
export function resolveLibraryRef(ref: string | undefined | null, byKey: Map<string, Media>): Media | null {
  if (!ref) return null;
  const direct = byKey.get(normalizeKey(ref));
  if (direct) return direct;
  const needle = normalizeKey(ref.includes("/") ? ref.split("/").slice(1).join("/") : ref);
  for (const [key, m] of byKey) if (key.endsWith(needle) || key.includes(needle)) return m;
  return null;
}

type BrainBeat = {
  id?: number;
  vo?: string;
  role?: string;
  shot_type?: string;
  style?: string;
  reference_plan?: { subject_lock?: boolean; pose_ref?: string; setting_ref?: string; mode?: string; library_asset?: string; edit_note?: string };
  image_prompt?: string;
  video_prompt?: string;
  negative_prompt?: string;
};
type BrainOutput = { subject_lock?: string; style_locks?: Record<string, string>; beats?: BrainBeat[] };

function parseBrainJson(text: string): BrainOutput {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < 0) throw new HttpError(502, "The brain did not return JSON", trimmed.slice(0, 300));
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as BrainOutput;
  } catch (err) {
    throw new HttpError(502, "The brain returned JSON that could not be parsed", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Runs the splitter on the board's script and replaces its beats.
 * Library references the brain names are resolved to media rows so the reference slots come pre-filled.
 */
export async function splitBoard(board: Board, subject: Subject | null): Promise<{ beats: Beat[]; brainOutput: BrainOutput; usage: { input: number; output: number } }> {
  if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, "ANTHROPIC_API_KEY is not set — add it to the environment to use the beat splitter");
  if (!board.script.trim()) throw new HttpError(400, "Paste a script first");

  const settings = await getSettings();
  const { lines, byKey } = await libraryIndex();
  const subjectLock = subject ? `${subject.name}: ${subject.base_prompt}`.trim() : "(none provided — describe the subject from the script and keep her consistent)";
  const system = settings.board_brain_prompt
    .replace("{{SUBJECT_LOCK}}", subjectLock)
    .replace("{{LIBRARY_INDEX}}", lines.length ? `\n${lines.join("\n")}` : "(library is empty)")
    .replace("{{SCRIPT}}", `\n${board.script.trim()}`);

  const client = new Anthropic();
  const stream = client.messages.stream({
    model: settings.board_brain_model,
    max_tokens: 32000,
    system,
    messages: [{ role: "user", content: "Produce the JSON board for the SCRIPT above." }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new HttpError(502, "The brain declined this script");
  if (message.stop_reason === "max_tokens") throw new HttpError(502, "The script is too long for one split — try a shorter script");
  const text = message.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  const out = parseBrainJson(text);
  const rawBeats = Array.isArray(out.beats) ? out.beats : [];
  if (!rawBeats.length) throw new HttpError(502, "The brain returned no beats");

  const rows = rawBeats.map((b, i) => {
    const plan = b.reference_plan ?? {};
    const pose = resolveLibraryRef(plan.pose_ref, byKey) ?? (plan.mode === "edit" || plan.mode === "reuse" ? resolveLibraryRef(plan.library_asset, byKey) : null);
    const setting = resolveLibraryRef(plan.setting_ref, byKey);
    const role: BeatRole = /^a/i.test(b.role ?? "") ? "aroll" : "broll";
    return {
      board_id: board.id,
      position: i,
      role,
      vo: (b.vo ?? "").trim(),
      shot_type: b.shot_type ?? null,
      style: b.style ?? null,
      image_prompt: (b.image_prompt ?? "").trim(),
      video_prompt: b.video_prompt ?? null,
      negative_prompt: b.negative_prompt ?? null,
      reference_plan: plan,
      use_subject_lock: plan.subject_lock !== false,
      pose_media_id: pose?.id ?? null,
      setting_media_id: setting?.id ?? null,
    };
  });

  const admin = createAdminClient();
  await admin.from("beats").delete().eq("board_id", board.id);
  const { data, error } = await admin.from("beats").insert(rows).select("*");
  if (error) throw new HttpError(500, error.message);
  const brainOutput = { subject_lock: out.subject_lock, style_locks: out.style_locks };
  await admin.from("boards").update({ brain_output: brainOutput, updated_at: new Date().toISOString() }).eq("id", board.id);
  return { beats: data as Beat[], brainOutput, usage: { input: message.usage.input_tokens, output: message.usage.output_tokens } };
}

// ─── generation ──────────────────────────────────────────────────────────────

/** The prompt sent to the image model for a beat: the brain's prompt, plus the edit note and negatives it can't send as fields. */
export function beatPrompt(beat: Beat): string {
  const parts = [beat.image_prompt.trim()];
  const plan = (beat.reference_plan ?? {}) as { mode?: string; edit_note?: string };
  if (plan.mode === "edit" && plan.edit_note) parts.push(`Using the attached reference as the base: ${plan.edit_note.trim()}`);
  if (beat.negative_prompt?.trim()) parts.push(`Do not include: ${beat.negative_prompt.trim()}.`);
  return parts.join("\n\n");
}

/** Reference images for a beat, in slot order: subject lock, pose/action, setting. Empty slots are skipped. */
export function beatReferences(beat: Beat, subject: Subject | null, media: Record<string, Media>): { url: string; slot: string }[] {
  const refs: { url: string; slot: string }[] = [];
  if (beat.use_subject_lock && subject?.media?.url) refs.push({ url: subject.media.url, slot: "subject" });
  if (beat.pose_media_id && media[beat.pose_media_id]) refs.push({ url: media[beat.pose_media_id].url, slot: "pose" });
  if (beat.setting_media_id && media[beat.setting_media_id]) refs.push({ url: media[beat.setting_media_id].url, slot: "setting" });
  return refs;
}

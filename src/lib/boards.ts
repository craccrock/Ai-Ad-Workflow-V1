import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { approvedExamplesBlock } from "@/lib/approved-examples";
import { LIBRARY_LEGEND, libraryLine } from "@/lib/library-cards";
import { HttpError, type Actor } from "@/lib/auth";
import { serializeGeneration } from "@/lib/generations";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSettings, imageRulesBlock } from "@/lib/settings";
import { imageBlockFromUrl } from "@/lib/vision";
import type { AvatarChunk, Beat, BeatRole, Board, BoardWithBeats, Generation, Media, Subject } from "@/lib/types";

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
  const [{ data: beats }, { data: chunks }, subject] = await Promise.all([
    admin.from("beats").select("*").eq("board_id", board.id).order("position"),
    admin.from("avatar_chunks").select("*").eq("board_id", board.id).order("position"),
    board.subject_id ? loadSubject(board.subject_id) : Promise.resolve(null),
  ]);
  const list = (beats ?? []) as Beat[];
  const avatarChunks = (chunks ?? []) as AvatarChunk[];
  const mediaIds = new Set<string>();
  const genIds = new Set<string>();
  for (const b of list) {
    if (b.pose_media_id) mediaIds.add(b.pose_media_id);
    if (b.setting_media_id) mediaIds.add(b.setting_media_id);
    for (const id of b.extra_media_ids ?? []) mediaIds.add(id);
    if (b.generation_id) genIds.add(b.generation_id);
    if (b.video_generation_id) genIds.add(b.video_generation_id);
  }
  for (const c of avatarChunks) if (c.generation_id) genIds.add(c.generation_id);
  if (subject?.media_id) mediaIds.add(subject.media_id);
  if (board.avatar_media_id) mediaIds.add(board.avatar_media_id);
  const [{ data: media }, { data: gens }] = await Promise.all([
    mediaIds.size ? admin.from("media").select("*").in("id", [...mediaIds]) : Promise.resolve({ data: [] as Media[] }),
    genIds.size ? admin.from("generations").select("*").in("id", [...genIds]) : Promise.resolve({ data: [] }),
  ]);
  return {
    ...board,
    subject,
    beats: list,
    avatar_chunks: avatarChunks,
    media: Object.fromEntries(((media ?? []) as Media[]).map((m) => [m.id, m])),
    generations: Object.fromEntries(((gens ?? []) as Generation[]).map((g) => [g.id, serializeGeneration(g)])),
  };
}

export async function loadSubject(id: string): Promise<Subject | null> {
  const { data } = await createAdminClient().from("subjects").select("*, media:media(*)").eq("id", id).maybeSingle();
  return (data as Subject | null) ?? null;
}

// ─── the brain ───────────────────────────────────────────────────────────────

/**
 * One line per library asset for the brain: the "Category / filename" key it writes back, then the vision card.
 * Assets the editor hid are left out; starred ones come first, then the best-scored.
 */
export async function libraryIndex(): Promise<{ lines: string[]; byKey: Map<string, Media> }> {
  const { data } = await createAdminClient().from("media").select("*").not("folder", "is", null).eq("type", "image").gte("rating", 0).order("folder").order("filename").limit(2000);
  const byKey = new Map<string, Media>();
  const rows = ((data ?? []) as Media[]).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.card?.quality ?? 0) - (a.card?.quality ?? 0));
  const lines: string[] = rows.length ? [LIBRARY_LEGEND] : [];
  for (const m of rows) {
    byKey.set(normalizeKey(`${m.folder} / ${m.filename}`), m);
    lines.push(libraryLine(m));
  }
  return { lines, byKey };
}

const normalizeKey = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]{2,4}$/i, "").replace(/\s+/g, " ").trim();

/** Resolve a "Category / filename" the brain wrote back to a library row; tolerant of extensions and spacing. */
export function resolveLibraryRef(ref: string | undefined | null, byKey: Map<string, Media>): Media | null {
  if (!ref) return null;
  ref = ref.split(" :: ")[0]; // the brain sometimes copies the whole index line, card included
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
export type BrainOutput = { subject_lock?: string; style_locks?: Record<string, string>; beats?: BrainBeat[] };

export function parseBrainJson(text: string): BrainOutput {
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
/** What the editor said when throwing a whole board out, plus a sample of the prompts being replaced. */
export type RedoDirection = { direction: string; rejected: { label: string; prompt: string }[] };

function redoBlock(redo?: RedoDirection): string {
  if (!redo?.direction.trim()) return "";
  const sample = redo.rejected
    .slice(0, 12)
    .map((r, i) => `[${i + 1}] ${r.label}: ${r.prompt.replace(/\s+/g, " ").slice(0, 500)}`)
    .join("\n");
  return `\n\nTHE EDITOR REJECTED THE WHOLE PREVIOUS BOARD FOR THIS SCRIPT. This is a redo, and their direction below is the most important instruction in this prompt. Follow it on every beat, including the choice of what each shot shows, not just the wording.\n\nEDITOR'S DIRECTION:\n${redo.direction.trim()}${sample ? `\n\nPROMPTS FROM THE REJECTED BOARD (what NOT to produce again; do not reuse their shot ideas unless the direction says the idea was fine):\n${sample}` : ""}`;
}

export async function splitBoard(board: Board, subject: Subject | null, redo?: RedoDirection): Promise<{ beats: Beat[]; brainOutput: BrainOutput; usage: { input: number; output: number } }> {
  if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, "ANTHROPIC_API_KEY is not set — add it to the environment to use the beat splitter");
  if (!board.script.trim()) throw new HttpError(400, "Paste a script first");

  const settings = await getSettings();
  const { lines, byKey } = await libraryIndex();
  const subjectLock = subject ? `${subject.name}: ${subject.base_prompt}`.trim() : "(none provided — describe the subject from the script and keep her consistent)";
  const system = settings.board_brain_prompt
    .replace("{{SUBJECT_LOCK}}", subjectLock)
    .replace("{{LIBRARY_INDEX}}", lines.length ? `\n${lines.join("\n")}` : "(library is empty)")
    .replace("{{SCRIPT}}", `\n${board.script.trim()}`) + (await approvedExamplesBlock("beat_image")) + (await imageRulesBlock()) + redoBlock(redo);

  const client = new Anthropic();
  const stream = client.messages.stream({
    model: settings.board_brain_model,
    max_tokens: 120000, // the model's reasoning counts against this; 32k was cutting long boards off mid-answer
    system,
    messages: [{ role: "user", content: "Produce the JSON board for the SCRIPT above." }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new HttpError(502, "The brain declined this script");
  if (message.stop_reason === "max_tokens") throw new HttpError(502, "Claude ran out of room before it finished writing the board. Nothing was changed and your note is still in the box. Press the button again; if it repeats, tell Claude Code so the limit can be raised.");
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
      extra_media_ids: [],
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
  // The brain's edit note usually says "swap the person for the subject"; it must not ride along once the subject lock is off.
  if (plan.mode === "edit" && plan.edit_note && beat.use_subject_lock) parts.push(`Using the attached reference as the base: ${plan.edit_note.trim()}`);
  if (beat.negative_prompt?.trim()) parts.push(`Do not include: ${beat.negative_prompt.trim()}.`);
  return parts.join("\n\n");
}

/** Reference images for a beat, in slot order: subject lock, pose/action, setting, then extras. Empty slots are skipped. */
export function beatReferences(beat: Beat, subject: Subject | null, media: Record<string, Media>): { url: string; slot: string }[] {
  const refs: { url: string; slot: string }[] = [];
  if (beat.use_subject_lock && subject?.media?.url) refs.push({ url: subject.media.url, slot: "subject" });
  if (beat.pose_media_id && media[beat.pose_media_id]) refs.push({ url: media[beat.pose_media_id].url, slot: "pose" });
  if (beat.setting_media_id && media[beat.setting_media_id]) refs.push({ url: media[beat.setting_media_id].url, slot: "setting" });
  (beat.extra_media_ids ?? []).forEach((id, i) => {
    if (media[id]) refs.push({ url: media[id].url, slot: `extra ${i + 1}` });
  });
  return refs;
}

// ─── reprompt ────────────────────────────────────────────────────────────────

/**
 * Rewrites one beat's image prompt according to the editor's direction, keeping the subject lock,
 * style locks and the beat's job in the script intact. Returns the new prompt (plain text).
 */
export async function repromptBeat(board: Board, subject: Subject | null, beat: Beat, direction: string, refs: { slot: string }[], opts: { resultUrl?: string | null; exampleUrls?: string[]; fresh?: boolean } = {}): Promise<{ image_prompt: string; reference_plan: Beat["reference_plan"]; diagnosis?: string; usage: { input: number; output: number } }> {
  if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, "ANTHROPIC_API_KEY is not set — add it to the environment to use reprompt");
  if (!direction.trim()) throw new HttpError(400, "Give a direction first");

  const settings = await getSettings();
  const brain = (board.brain_output ?? {}) as BrainOutput;
  const fresh = Boolean(opts.fresh);
  // The per-beat "lock" tick decides whether the board's subject exists for this beat at all.
  const subjectOn = beat.use_subject_lock && !fresh;
  const subjectText = subject ? `${subject.name}: ${subject.base_prompt}`.trim() : brain.subject_lock || "";
  const subjectLock = subjectOn && subjectText ? subjectText : "OFF for this beat. The board's subject does not appear here — do not name or describe them, their ethnicity, hair, wardrobe or jewellery. Describe the people from the direction and the reference images only.";
  const styleLocks = brain.style_locks && Object.keys(brain.style_locks).length ? Object.entries(brain.style_locks).map(([k, v]) => `- ${k}: ${v}`).join("\n") : "(none)";
  const slots = refs.length ? refs.map((r, i) => `image ${i + 1} = ${r.slot}`).join(", ") : "none attached";
  const plan = (beat.reference_plan ?? {}) as { mode?: string; edit_note?: string };
  const editNote = subjectOn && plan.mode === "edit" && plan.edit_note ? plan.edit_note.trim() : "";

  const system = `You rewrite image-generation prompts for a UGC-style ad storyboard. The prompt you write is sent as-is to Nano Banana (Google image model) together with the reference images listed below, so write it as a single finished prompt: no headings, no options, no commentary, no quotes around it.

Rules:
- The editor's direction wins over everything else below, including the SUBJECT LOCK, the STYLE LOCKS and the CURRENT PROMPT. Add what they ask to add, remove what they ask to remove, change what they ask to change. Keep everything else that still fits.
- If the direction puts a different person in the shot (named, described, or pointed at in a reference or example image), the locked subject is OUT of this beat: do not mention their name, ethnicity, skin tone, hair, wardrobe or jewellery anywhere, and describe the new person from the direction and the images instead. Never "restore" a locked subject the editor replaced.
- Otherwise keep the SUBJECT LOCK and STYLE LOCKS.
- The image must still serve the voiceover line it sits under.
- If reference images are attached, refer to them by number ("the woman in image 1", "the pose in image 2") when the prompt depends on them.
- Default length: a dense paragraph (80–160 words). If the direction asks for longer or more detailed, go to 160–260 words with concrete lighting, lens, framing, wardrobe, texture and setting detail. If it asks for shorter, cut.
- Photoreal unless the style locks say otherwise. 9:16 vertical.
- If an image is attached, it is what the CURRENT PROMPT actually produced. Study it first and list what went wrong against the intent and the direction (wrong person or skin tone, extra or fused fingers, warped anatomy, wrong framing, missing props or wardrobe, text, stylised or CGI look, wrong setting). Then write the new prompt so those faults cannot recur: state the correct version explicitly and positively (what the hands do, how many people, exact wardrobe, exact framing), and keep everything that was already right.
- If EXAMPLE images are attached, they show the look the editor is aiming for (realism, lighting, framing, skin and surface texture, colour, lens feel). Translate those qualities into concrete words in the new prompt, applying the direction (e.g. "like this but the camera a little farther back"). Examples are NOT sent to the image model unless the editor also adds them as references, so the words must carry the look.
- Output: if a result image was attached, the first line is "DIAGNOSIS: <one or two plain sentences>", then a blank line, then the prompt. Otherwise output only the prompt text.
- Never write a note, caveat or explanation to the editor inside the prompt: every word after the optional first line is sent to the image model. If you departed from the direction in any way, say so in one sentence on a first line starting "NOTE: ", then a blank line, then the prompt.

SUBJECT LOCK: ${subjectLock}
STYLE LOCKS:
${styleLocks}
REFERENCE IMAGES ATTACHED: ${slots}${await approvedExamplesBlock("beat_image")}${await imageRulesBlock()}`;

  const currentPrompt = fresh ? "(none — the editor asked to START FROM SCRATCH. Ignore whatever prompt existed before; build a brand-new prompt from the voiceover, the direction and the reference images only.)" : beat.image_prompt.trim() || "(empty)";
  const user = `VOICEOVER FOR THIS BEAT: ${beat.vo || "(none)"}
ROLE: ${beat.role === "aroll" ? "A-roll (talent on camera)" : "B-roll"}
${beat.shot_type ? `SHOT TYPE: ${beat.shot_type}\n` : ""}CURRENT PROMPT:
${currentPrompt}
${editNote ? `\nBRAIN'S EDIT NOTE (was appended to the current prompt at generation time; it is dropped after this rewrite, so fold in whatever still applies and nothing that the direction contradicts):\n${editNote}\n` : ""}
EDITOR'S DIRECTION:
${direction.trim()}

Write the new prompt.`;

  const content: Anthropic.ContentBlockParam[] = [];
  const resultImage = opts.resultUrl ? await imageBlockFromUrl(opts.resultUrl) : null;
  if (resultImage) content.push({ type: "text", text: "This is the image the CURRENT PROMPT produced:" }, resultImage);
  let n = 0;
  for (const url of opts.exampleUrls ?? []) {
    const block = await imageBlockFromUrl(url);
    if (block) content.push({ type: "text", text: `EXAMPLE ${++n} from the editor (the look to aim for):` }, block);
  }
  content.push({ type: "text", text: user });

  const client = new Anthropic();
  const message = await client.messages.stream({ model: settings.board_brain_model, max_tokens: 12000, system, messages: [{ role: "user", content }] }).finalMessage();
  if (message.stop_reason === "refusal") throw new HttpError(502, "The brain declined this direction");
  let text = message.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
  let diagnosis: string | undefined;
  const m = text.match(/^(?:DIAGNOSIS|NOTE|Note for the editor):\s*([\s\S]*?)\n\s*\n([\s\S]*)$/i);
  if (m) {
    diagnosis = m[1].trim();
    text = m[2].trim();
  }
  text = text.replace(/^["“]|["”]$/g, "").trim();
  if (!text) throw new HttpError(502, "The brain returned an empty prompt");

  // The rewritten prompt now carries (or deliberately drops) the brain's edit note, so stop appending it at generation time.
  const { edit_note: _dropped, ...restPlan } = (beat.reference_plan ?? {}) as Record<string, unknown>;
  void _dropped;
  const reference_plan = (beat.reference_plan ? restPlan : null) as Beat["reference_plan"];
  const admin = createAdminClient();
  await admin.from("beats").update({ image_prompt: text, reference_plan }).eq("id", beat.id);
  return { image_prompt: text, reference_plan, diagnosis, usage: { input: message.usage.input_tokens, output: message.usage.output_tokens } };
}

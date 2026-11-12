import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { getSettings } from "@/lib/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import type { LibraryCard, Media } from "@/lib/types";
import { imageBlockFromUrl } from "@/lib/vision";

/** Folder that thumbs-upped takes and takes from finished ads are copied into. */
export const WINNERS_FOLDER = "Winners";

const STYLES = ["ugc_real", "anatomy", "clay", "animated", "product", "other"] as const;
const USES = ["pose", "setting", "as_is"] as const;

const CARD_PROMPT = `You are cataloguing one image from the reference library of an AI UGC ad studio (direct-response ads, mostly skincare for women 45+). A separate writer, who cannot see the image, will read ONLY your card to decide whether this image is the right reference for a line of an ad script. Be literal and specific about what is actually visible. Do not guess at things you cannot see.

Return ONLY a JSON object, no prose and no code fence:
{
  "summary": "<one sentence, max 30 words: who or what is shown, what they are doing, and where>",
  "subject": "<the people shown: count, apparent age range, gender, skin tone, hair, clothing; or 'none' for anatomy, product or object shots>",
  "framing": "<camera: selfie, POV, over-the-shoulder, from behind, close-up, medium, wide; angle and distance>",
  "style": "<exactly one of: ugc_real (real phone footage or photoreal), anatomy (3D medical render or diagram), clay (claymation), animated (stylised 3D or cartoon), product (product or packaging shot), other>",
  "quality": <integer 1-5 for how good a REFERENCE this is: 5 = sharp, well lit, clean composition, one clear action; 3 = usable but soft, cluttered or awkwardly cropped; 1 = blurry, heavy compression, watermarks, captions or UI burned in, or otherwise poor>,
  "use_as": [<any of "pose" (the body position, action or camera angle is worth copying with a different person), "setting" (the room or location is worth copying), "as_is" (it can go into an ad unchanged because no specific person's face identifies it, such as anatomy, mechanism, product, or hands and backs only)>],
  "good_for": "<max 25 words: the kinds of script moments this fits, e.g. 'doctor freezing a spot', 'frustration at the mirror', 'keratin building under the skin'>",
  "issues": "<max 20 words: anything that makes it a risky reference, such as burned-in captions or subtitles, a watermark, another brand's product or logo, a recognisable face, low resolution, a duplicate look; or 'none'>"
}`;

function parseJson(text: string): Record<string, unknown> {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("no JSON in the reply");
  return JSON.parse(t.slice(a, b + 1)) as Record<string, unknown>;
}

const str = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function normalizeCard(raw: Record<string, unknown>, model: string): LibraryCard {
  const style = STYLES.includes(raw.style as (typeof STYLES)[number]) ? (raw.style as LibraryCard["style"]) : "other";
  const use = Array.isArray(raw.use_as) ? (raw.use_as.filter((u) => USES.includes(u as (typeof USES)[number])) as LibraryCard["use_as"]) : [];
  const q = Math.round(Number(raw.quality));
  return {
    summary: str(raw.summary, 260),
    subject: str(raw.subject, 260),
    framing: str(raw.framing, 160),
    style,
    quality: Number.isFinite(q) ? Math.min(5, Math.max(1, q)) : 3,
    use_as: use,
    good_for: str(raw.good_for, 220),
    issues: str(raw.issues, 200) || "none",
    model,
    at: new Date().toISOString(),
  };
}

/** Has Claude look at one library image and saves the card it writes. Throws when the image can't be read. */
export async function describeMedia(media: Pick<Media, "id" | "url" | "filename" | "folder">): Promise<LibraryCard> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  const image = await imageBlockFromUrl(media.url);
  if (!image) throw new Error("the image could not be downloaded");
  const { board_brain_model: model } = await getSettings();
  const msg = await new Anthropic().messages.create({
    model,
    max_tokens: 1200,
    messages: [{ role: "user", content: [image, { type: "text", text: `${CARD_PROMPT}\n\nFor context only (do not trust it over what you see), the file is currently named: "${media.folder ?? ""} / ${media.filename}"` }] }],
  });
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const card = normalizeCard(parseJson(text), model);
  const { error } = await createAdminClient().from("media").update({ card }).eq("id", media.id);
  if (error) throw new Error(error.message);
  return card;
}

const libraryImages = () => createAdminClient().from("media").select("id", { count: "exact", head: true }).not("folder", "is", null).eq("type", "image");

export async function cardStatus(): Promise<{ total: number; described: number; remaining: number }> {
  const [{ count: total }, { count: remaining }] = await Promise.all([libraryImages(), libraryImages().is("card", null)]);
  return { total: total ?? 0, described: (total ?? 0) - (remaining ?? 0), remaining: remaining ?? 0 };
}

/** Describes up to `limit` library images that have no card yet, a few at a time. */
export async function describePending(limit = 8): Promise<{ described: number; failed: { id: string; filename: string; error: string }[] }> {
  const { data } = await createAdminClient().from("media").select("id, url, filename, folder").not("folder", "is", null).eq("type", "image").is("card", null).order("created_at", { ascending: true }).limit(limit);
  const rows = (data ?? []) as Pick<Media, "id" | "url" | "filename" | "folder">[];
  let described = 0;
  const failed: { id: string; filename: string; error: string }[] = [];
  const queue = [...rows];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        try {
          await describeMedia(m);
          described += 1;
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          failed.push({ id: m.id, filename: m.filename, error });
          // Park it with a stub so one unreadable file doesn't block the queue forever; "Redo" re-describes it.
          await createAdminClient().from("media").update({ card: { summary: "", subject: "", framing: "", style: "other", quality: 1, use_as: [], good_for: "", issues: `could not be described: ${error}`.slice(0, 200), model: "", at: new Date().toISOString(), failed: true } }).eq("id", m.id);
        }
      }
    }),
  );
  return { described, failed };
}

/** One line of the splitter's LIBRARY_INDEX: the key it must write back, then what the image actually shows. */
export function libraryLine(m: Media): string {
  const key = `${m.folder} / ${m.filename}`;
  const c = m.card;
  if (!c || c.failed || !c.summary) return m.rating === 1 ? `${key} :: ★ starred by the editor` : key;
  const bits = [
    m.rating === 1 ? "★ starred by the editor" : null,
    `quality ${c.quality}/5`,
    c.style,
    c.use_as.length ? `use as: ${c.use_as.join(", ")}` : "use as: nothing recommended",
    c.summary,
    c.subject && c.subject.toLowerCase() !== "none" ? `people: ${c.subject}` : null,
    c.framing ? `framing: ${c.framing}` : null,
    c.good_for ? `fits: ${c.good_for}` : null,
    c.issues && c.issues.toLowerCase() !== "none" ? `watch out: ${c.issues}` : null,
  ].filter(Boolean);
  return `${key} :: ${bits.join(" | ")}`;
}

export const LIBRARY_LEGEND =
  'Each line is "Category / filename :: card". When you reference an asset, write back ONLY the "Category / filename" part. The card was written by a model that looked at the image, so trust it over the filename. Prefer ★ starred assets and higher quality scores when several fit; an asset whose card does not actually match the beat is worse than no asset. "Winners" are takes this editor approved on earlier boards: they show the look the editor wants, and they make strong pose and setting references.';

/**
 * Copies an approved take into the library's Winners folder (its own file, so retention never deletes it), stars it
 * and has Claude write its card. Safe to call twice for the same take. Returns null when the take has no image left.
 */
export async function promoteWinner(input: { userId: string; generationId: string; label?: string | null; prompt?: string | null; boardId?: string | null; reason: "thumbs_up" | "final_cut" }): Promise<Media | null> {
  const admin = createAdminClient();
  const { data: existing } = await admin.from("media").select("*").eq("source_generation_id", input.generationId).maybeSingle();
  if (existing) {
    const row = existing as Media;
    // A thumbs-up on something already in the library is a star; a hidden item stays hidden.
    if (input.reason === "thumbs_up" && (row.rating ?? 0) === 0) await admin.from("media").update({ rating: 1 }).eq("id", row.id);
    return row;
  }
  const { data: gen } = await admin.from("generations").select("id, media_type, result_url, prompt, model_display_name, provider").eq("id", input.generationId).maybeSingle();
  if (!gen || gen.media_type !== "image" || !gen.result_url) return null;

  const res = await fetch(gen.result_url as string, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  const mime = res.headers.get("content-type")?.split(";")[0] ?? "image/png";
  if (!mime.startsWith("image/")) return null;
  const body = Buffer.from(await res.arrayBuffer());
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
  const path = `${input.userId}/${randomUUID()}.${ext}`;
  const { error: upErr } = await admin.storage.from("media").upload(path, body, { contentType: mime, cacheControl: "31536000, immutable" });
  if (upErr) throw new Error(upErr.message);
  const { data: pub } = admin.storage.from("media").getPublicUrl(path);

  const label = (input.label ?? "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "approved take";
  const { data, error } = await admin
    .from("media")
    .insert({
      user_id: input.userId,
      type: "image",
      filename: `Winner - ${label} - ${input.generationId.slice(0, 6)}`,
      storage_path: path,
      url: pub.publicUrl,
      file_size_bytes: body.byteLength,
      metadata: { mime_type: mime, prompt: (input.prompt ?? (gen.prompt as string | null) ?? "").slice(0, 4000), model: gen.model_display_name, board_id: input.boardId ?? null, reason: input.reason },
      folder: WINNERS_FOLDER,
      tags: ["winner", input.reason],
      // Only an explicit thumbs-up stars it; a take that merely made a cut is offered like any other asset.
      rating: input.reason === "thumbs_up" ? 1 : 0,
      source_generation_id: input.generationId,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  const media = data as Media;
  try {
    media.card = await describeMedia(media);
  } catch {
    // Left without a card; the Library's "Describe" pass picks it up.
  }
  return media;
}

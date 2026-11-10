import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { STARTER_SYSTEM_PROMPT } from "@/config/starter";
import { HttpError } from "@/lib/auth";
import { serializeGeneration, syncGeneration, USER_SELECT } from "@/lib/generations";
import { getSettings } from "@/lib/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import type { GenerationWithUser } from "@/lib/types";
import { imageBlockFromUrl } from "@/lib/vision";

export type StarterImage = { url: string; send: boolean };

/**
 * Turns the editor's brief (a direction plus attached images) into one finished image prompt. Claude sees every
 * attached image; the ones marked `send` also go to the image model and are numbered in that order, so the prompt
 * can say "the woman in image 1".
 */
export async function writeStarterPrompt(input: { direction: string; images: StarterImage[]; currentPrompt?: string }): Promise<{ prompt: string; usage: { input: number; output: number } }> {
  if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, "ANTHROPIC_API_KEY is not set, so the prompt writer can't run");
  const direction = input.direction.trim();
  if (!direction) throw new HttpError(400, "Say what you want first");

  const content: Anthropic.ContentBlockParam[] = [];
  let sent = 0;
  let look = 0;
  for (const img of input.images) {
    const block = await imageBlockFromUrl(img.url);
    if (!block) continue;
    content.push({ type: "text", text: img.send ? `IMAGE ${++sent}, SENT TO THE MODEL as reference image ${sent}:` : `LOOK ONLY example ${++look} (not sent to the model):` }, block);
  }
  const current = input.currentPrompt?.trim();
  content.push({
    type: "text",
    text: `${sent ? `${sent} reference image${sent === 1 ? " is" : "s are"} sent to the model with this prompt.` : "No reference images are sent to the model: the prompt must describe the person and the place completely."}
${current ? `\nCURRENT PROMPT (revise this):\n${current}\n` : ""}
EDITOR'S DIRECTION:
${direction}

Write the prompt.`,
  });

  const settings = await getSettings();
  const client = new Anthropic();
  const message = await client.messages.stream({ model: settings.board_brain_model, max_tokens: 2000, system: STARTER_SYSTEM_PROMPT, messages: [{ role: "user", content }] }).finalMessage();
  if (message.stop_reason === "refusal") throw new HttpError(502, "The prompt writer declined this brief");
  const prompt = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    .replace(/^["“]|["”]$/g, "")
    .trim();
  if (!prompt) throw new HttpError(502, "The prompt writer returned nothing");
  return { prompt, usage: { input: message.usage.input_tokens, output: message.usage.output_tokens } };
}

export type StarterTake = ReturnType<typeof serializeGeneration> & { favorite: boolean; direction: string | null };

/** Every take made on the Starter tab, newest first, with in-flight jobs synced against the provider. */
export async function listStarterTakes(limit = 200): Promise<StarterTake[]> {
  const admin = createAdminClient();
  const { data: takes, error } = await admin.from("starter_takes").select("generation_id, favorite, direction, created_at").order("created_at", { ascending: false }).limit(limit);
  if (error) throw new HttpError(500, error.message);
  if (!takes?.length) return [];
  const { data: gens, error: gErr } = await admin
    .from("generations")
    .select(USER_SELECT)
    .in(
      "id",
      takes.map((t) => t.generation_id),
    );
  if (gErr) throw new HttpError(500, gErr.message);
  const byId = new Map((gens as GenerationWithUser[]).map((g) => [g.id, g]));
  const out: StarterTake[] = [];
  for (const t of takes) {
    let g = byId.get(t.generation_id);
    if (!g) continue;
    if (g.status === "queued" || g.status === "processing") g = { ...(await syncGeneration(g)), user: g.user };
    out.push({ ...serializeGeneration(g), favorite: t.favorite, direction: t.direction });
  }
  return out;
}

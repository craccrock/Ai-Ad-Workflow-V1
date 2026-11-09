import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { transcribeWords } from "@/lib/transcribe";
import type { TranscriptWord } from "@/lib/types";

/**
 * Word timestamps for one generated clip, transcribed once with Scribe and cached in `clip_transcripts`
 * (a finished clip never changes, so the cache never expires). Returns [] when the clip has no speech.
 */
export async function clipWords(generationId: string, url: string): Promise<TranscriptWord[]> {
  const admin = createAdminClient();
  const { data } = await admin.from("clip_transcripts").select("words").eq("generation_id", generationId).maybeSingle();
  if (data?.words) return data.words as TranscriptWord[];
  let words: TranscriptWord[] = [];
  let text = "";
  try {
    const res = await transcribeWords(url);
    words = res.words;
    text = res.text;
  } catch (e) {
    // "no words" is a real answer for a silent clip; anything else should surface.
    if (!(e instanceof Error && /no words/i.test(e.message))) throw e;
  }
  await admin.from("clip_transcripts").upsert({ generation_id: generationId, words, text }, { onConflict: "generation_id" });
  return words;
}

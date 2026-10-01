import "server-only";
import { HttpError, type Actor } from "@/lib/auth";
import { getGenerationForActor } from "@/lib/generations";
import { createAdminClient } from "@/lib/supabase/admin";
import { kieInlineTask } from "@/providers/kie";
import { toLines, type AlignedWord, type TimedLine, type TimedWord } from "@/lib/lyric-lines";

type KieLyrics = { alignedWords?: AlignedWord[]; aligned_words?: AlignedWord[]; hootCer?: number; hoot_cer?: number };
type Track = { audio_id?: string; url?: string; duration_seconds?: number; title?: string };

export type SongTiming = {
  job_id: string;
  take: number;
  audio_id: string;
  url?: string;
  duration_seconds?: number;
  /** Lower is better; Suno's character error rate for the alignment. */
  alignment_error?: number;
  lines: TimedLine[];
  words: TimedWord[];
};

/**
 * Word- and line-level timings for one take of a finished Suno job, for cutting a storyboard to the song.
 * Costs Kie 0.5 credits ($0.0025) the first time; the result is cached on the job.
 */
export async function songTiming(actor: Actor, jobId: string, take = 1): Promise<SongTiming> {
  const row = await getGenerationForActor(actor, jobId);
  if (row.model !== "suno") throw new HttpError(400, "Lyric timings are only available for Suno songs.");
  if (row.status !== "completed") throw new HttpError(409, `This song is ${row.status}; timings are available once it completes.`);

  const meta = (row.result_metadata ?? {}) as Record<string, unknown> & { provider?: { task_id?: string; tracks?: Track[] }; lyric_timings?: Record<string, SongTiming> };
  const cached = meta.lyric_timings?.[String(take)];
  if (cached) return cached;

  const tracks = meta.provider?.tracks ?? [];
  const track = tracks[take - 1];
  const taskId = meta.provider?.task_id ?? row.provider_request_id;
  if (!track?.audio_id || !taskId) throw new HttpError(404, `Take ${take} not found on this job (it has ${tracks.length}).`);
  if (row.params.settings?.instrumental) throw new HttpError(400, "This song is instrumental, so there are no lyrics to time.");

  const result = await kieInlineTask<KieLyrics>("ai-music-api/timeStamped-lyrics", { task_id: taskId, audio_id: track.audio_id });
  const aligned = result.alignedWords ?? result.aligned_words ?? [];
  if (!aligned.length) throw new HttpError(502, "Kie returned no lyric timings for this take.");

  const timing: SongTiming = {
    job_id: row.id,
    take,
    audio_id: track.audio_id,
    url: track.url,
    duration_seconds: track.duration_seconds,
    alignment_error: result.hootCer ?? result.hoot_cer,
    ...toLines(aligned),
  };
  await createAdminClient()
    .from("generations")
    .update({ result_metadata: { ...meta, lyric_timings: { ...meta.lyric_timings, [String(take)]: timing } } })
    .eq("id", row.id);
  return timing;
}

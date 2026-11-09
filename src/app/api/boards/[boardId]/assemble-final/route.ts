import { assembleFinal } from "@/lib/assemble";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { canEditBoard, getBoardForActor, loadBoardWithBeats } from "@/lib/boards";
import { cutRulesFrom, getSettings } from "@/lib/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { transcribeWords } from "@/lib/transcribe";
import type { AvatarAssembly } from "@/lib/types";

export const maxDuration = 300;

/**
 * POST /api/boards/:id/assemble-final — lays the B-roll clips over the A-roll track where their lines are spoken.
 * Transcribes the A-roll once (word timestamps are cached on the track) and reuses them on every re-cut.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/boards/[boardId]/assemble-final">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { boardId } = await ctx.params;
    const board = await getBoardForActor(actor, boardId);
    if (!canEditBoard(actor, board)) throw new HttpError(403, "Only the board's owner or an admin can assemble");
    if (!board.avatar_assembly?.url) throw new HttpError(422, "Assemble the A-roll first");

    let track: AvatarAssembly = board.avatar_assembly;
    let transcribed = false;
    if (!track.words?.length) {
      const { words } = await transcribeWords(track.url);
      track = { ...track, words };
      await createAdminClient().from("boards").update({ avatar_assembly: track }).eq("id", boardId);
      transcribed = true;
    }
    const full = await loadBoardWithBeats({ ...board, avatar_assembly: track });
    const assembly = await assembleFinal({ ...board, avatar_assembly: track }, full.beats, full.generations, track.words!, actor.profile.id, cutRulesFrom(await getSettings()));
    return Response.json({ assembly, avatar_assembly: track, transcribed });
  });
}

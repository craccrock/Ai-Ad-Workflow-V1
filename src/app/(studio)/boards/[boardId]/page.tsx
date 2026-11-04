import { notFound } from "next/navigation";
import { BoardEditor } from "@/components/boards/board-editor";
import { requireSessionProfile } from "@/lib/auth";
import { loadBoardWithBeats } from "@/lib/boards";
import { getSettings } from "@/lib/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Board } from "@/lib/types";

export default async function BoardPage({ params }: PageProps<"/boards/[boardId]">) {
  const profile = await requireSessionProfile();
  const { boardId } = await params;
  const { data } = await createAdminClient().from("boards").select("*").eq("id", boardId).maybeSingle();
  if (!data) notFound();
  const [board, settings] = await Promise.all([loadBoardWithBeats(data as Board), getSettings()]);
  return <BoardEditor initial={board} profile={profile} concurrency={settings.board_concurrency} />;
}

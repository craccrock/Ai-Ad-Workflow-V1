import { BoardList, type BoardSummary } from "@/components/boards/board-list";
import { requireSessionProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export default async function BoardsPage() {
  const profile = await requireSessionProfile();
  const { data } = await createAdminClient()
    .from("boards")
    .select("id, title, user_id, model, aspect_ratio, created_at, updated_at, user:profiles(id, display_name), beats(count)")
    .order("updated_at", { ascending: false });
  return <BoardList boards={(data ?? []) as unknown as BoardSummary[]} profile={profile} />;
}

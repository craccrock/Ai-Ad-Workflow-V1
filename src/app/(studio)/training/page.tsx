import { TrainingPanel, type PastCut } from "@/components/training/training-panel";
import { PageHeader } from "@/components/ui/misc";
import { requireSessionProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AvatarAssembly, EditNote, FinalAssembly, ReferenceEdit } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function TrainingPage() {
  const profile = await requireSessionProfile();
  const admin = createAdminClient();
  const [{ data: refs }, { data: boards }, { data: notes }] = await Promise.all([
    admin.from("reference_edits").select("*").order("created_at", { ascending: false }),
    admin.from("boards").select("id, title, avatar_assembly, final_assembly, updated_at").or("avatar_assembly.not.is.null,final_assembly.not.is.null").order("updated_at", { ascending: false }).limit(60),
    admin.from("learning_events").select("id, board_id, target_type, note, meta, created_at, user_id").eq("kind", "edit_note").order("created_at", { ascending: false }).limit(400),
  ]);

  const notesByBoard = new Map<string, EditNote[]>();
  for (const n of notes ?? []) {
    if (!n.board_id) continue;
    const list = notesByBoard.get(n.board_id) ?? [];
    list.push({ id: n.id, target_type: n.target_type as "aroll" | "final", note: n.note ?? "", at_s: ((n.meta as { at_s?: number | null })?.at_s ?? null) as number | null, created_at: n.created_at, user_id: n.user_id });
    notesByBoard.set(n.board_id, list);
  }
  const pastCuts: PastCut[] = (boards ?? []).map((b) => {
    const a = b.avatar_assembly as AvatarAssembly | null;
    const f = b.final_assembly as FinalAssembly | null;
    return {
      board_id: b.id,
      title: b.title,
      aroll: a ? { duration_s: a.duration_s, clips: a.chunk_ids.length, created_at: a.created_at, url: a.url } : null,
      final: f ? { duration_s: f.duration_s, placed: f.placements.length, skipped: f.skipped.length, created_at: f.created_at, url: f.url } : null,
      notes: notesByBoard.get(b.id) ?? [],
    };
  });

  return (
    <>
      <PageHeader title="Training" subtitle="Teach the cutter. Upload ads you edited by hand to give it a pacing profile, set the rules it follows, and review every cut it has made with the notes left on them." />
      <TrainingPanel initialReferences={(refs ?? []) as ReferenceEdit[]} pastCuts={pastCuts} userId={profile.id} isAdmin={profile.role === "admin"} />
    </>
  );
}

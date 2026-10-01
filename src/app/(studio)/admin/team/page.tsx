import { TeamManager, type ApiKeyRow, type TeamMember } from "@/components/admin/team-manager";
import { PageHeader } from "@/components/ui/misc";
import { requireSessionProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Profile } from "@/lib/types";

export default async function TeamPage() {
  const me = await requireSessionProfile({ admin: true });
  const admin = createAdminClient();
  const [{ data: profiles }, { data: keys }, { data: authUsers }] = await Promise.all([
    admin.from("profiles").select("*").order("created_at"),
    admin.from("api_keys").select("id, user_id, key_prefix, label, last_used_at, revoked_at, created_at").order("created_at", { ascending: false }),
    admin.auth.admin.listUsers({ perPage: 1000 }),
  ]);

  const authById = new Map((authUsers?.users ?? []).map((u) => [u.id, u]));
  const members: TeamMember[] = ((profiles ?? []) as Profile[]).map((p) => {
    const u = authById.get(p.id);
    return {
      ...p,
      last_sign_in_at: u?.last_sign_in_at ?? null,
      temp_password: Boolean(!p.is_bot && u?.app_metadata?.must_change_password),
      deactivated: Boolean(u?.banned_until && new Date(u.banned_until) > new Date()),
    };
  });

  return (
    <>
      <PageHeader title="Team & API" subtitle="Add editors, reset passwords, manage roles, and issue API keys." />
      <TeamManager me={me} members={members} apiKeys={(keys ?? []) as ApiKeyRow[]} />
    </>
  );
}

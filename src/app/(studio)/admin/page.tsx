import { SpendDashboard, type SpendStats } from "@/components/admin/spend-dashboard";
import { PageHeader } from "@/components/ui/misc";
import { requireSessionProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export default async function SpendPage() {
  await requireSessionProfile({ admin: true });
  const { data, error } = await createAdminClient().rpc("spend_stats", { p_days: 30, p_tz: process.env.SPEND_TIMEZONE ?? "America/New_York" });

  return (
    <>
      <PageHeader title="Spend" subtitle="Actual provider cost where reported, otherwise the config estimate. Failed jobs excluded." />
      {error ? <p className="text-sm text-danger">Couldn&apos;t load spend: {error.message}</p> : <SpendDashboard stats={data as SpendStats} />}
    </>
  );
}

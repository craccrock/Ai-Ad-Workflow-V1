import { StarterStudio, type StarterTake } from "@/components/starter/starter-studio";
import { PageHeader } from "@/components/ui/misc";
import { requireSessionProfile } from "@/lib/auth";
import { listStarterTakes } from "@/lib/starter";

export const dynamic = "force-dynamic";

export default async function StarterPage() {
  const profile = await requireSessionProfile();
  const takes = (await listStarterTakes()) as unknown as StarterTake[];
  return (
    <>
      <PageHeader title="Starter images" subtitle="The still an ad is built on. Brief Claude with example images and a direction, run the prompt on the Nano Banana models side by side, and keep iterating: re-run, reuse a setup, or drag any take back up as a reference." />
      <StarterStudio initialTakes={takes} userId={profile.id} isAdmin={profile.role === "admin"} />
    </>
  );
}

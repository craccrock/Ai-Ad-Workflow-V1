import { Suspense } from "react";
import { Studio } from "@/components/studio/studio";
import { requireSessionProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { accountVoices } from "@/providers/elevenlabs";
import { getTypicalDurations } from "@/lib/typical-durations";

export default async function StudioPage() {
  const profile = await requireSessionProfile();
  const supabase = await createClient();
  const [{ data: team }, typicalDurations, voices] = await Promise.all([
    supabase.from("profiles").select("id, display_name").order("display_name"),
    getTypicalDurations(),
    // Voiceover models need the account's own voice library; a missing key just hides the list.
    accountVoices()
      .then((list) => list.map((v) => ({ value: v.id, label: v.name, hint: v.hint, previewUrl: v.previewUrl })))
      .catch((err) => {
        console.warn("[studio] could not load ElevenLabs voices:", err instanceof Error ? err.message : err);
        return [];
      }),
  ]);
  return (
    <Suspense>
      <Studio profile={profile} team={team ?? []} typicalDurations={typicalDurations} retentionDays={env.retentionDays} voices={voices} />
    </Suspense>
  );
}

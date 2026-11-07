import { SettingsForm } from "@/components/admin/settings-form";
import { PageHeader } from "@/components/ui/misc";
import { DEFAULT_BRAIN_PROMPT } from "@/config/board-brain-prompt";
import { DEFAULT_VIDEO_PROMPT } from "@/config/board-video-prompt";
import { requireSessionProfile } from "@/lib/auth";
import { getSettings } from "@/lib/settings";

export default async function SettingsPage() {
  await requireSessionProfile({ admin: true });
  const settings = await getSettings();
  return (
    <>
      <PageHeader title="Settings" subtitle="The brain prompt and defaults behind the B-roll boards. Changes apply to the next split." />
      <SettingsForm initial={settings} defaultPrompt={DEFAULT_BRAIN_PROMPT} defaultVideoPrompt={DEFAULT_VIDEO_PROMPT} anthropicConfigured={Boolean(process.env.ANTHROPIC_API_KEY)} />
    </>
  );
}

import { syncGeneration } from "@/lib/generations";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Generation } from "@/lib/types";

export const maxDuration = 300;

/**
 * POST /api/webhooks/kie — Kie calls this (`callBackUrl`) when a task finishes.
 * The payload is treated only as a hint: we look up the job by task id and re-query Kie
 * with our own key, so a forged callback can't inject results or trigger a fallback.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { taskId?: string; data?: { taskId?: string; task_id?: string } } | null;
  const taskId = body?.data?.taskId ?? body?.taskId ?? body?.data?.task_id;
  if (!taskId) return Response.json({ ok: false }, { status: 400 });

  const { data } = await createAdminClient()
    .from("generations")
    .select("*")
    .eq("provider", "kie")
    .eq("provider_request_id", taskId)
    .maybeSingle();

  if (data) await syncGeneration(data as Generation, { force: true });
  return Response.json({ ok: true });
}

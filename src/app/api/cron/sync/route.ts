import { env } from "@/lib/env";
import { syncGeneration } from "@/lib/generations";
import { recopyProviderHosted } from "@/lib/recopy";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Generation } from "@/lib/types";

export const maxDuration = 300;

/**
 * GET /api/cron/sync — sweeps in-flight jobs nobody is polling (e.g. an API client that
 * never checked back). Protected by CRON_SECRET (Vercel Cron sends it as a Bearer token).
 */
export async function GET(request: Request) {
  const secret = env.cronSecret;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data } = await createAdminClient()
    .from("generations")
    .select("*")
    .in("status", ["queued", "processing"])
    .order("created_at", { ascending: true })
    .limit(100);

  const results = await Promise.all((data as Generation[]).map((row) => syncGeneration(row)));
  const counts = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  const recopied = await recopyProviderHosted({ limit: 25 });
  return Response.json({ checked: results.length, ...counts, recopied });
}

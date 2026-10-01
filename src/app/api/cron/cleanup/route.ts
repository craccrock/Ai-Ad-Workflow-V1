import { env } from "@/lib/env";
import { purgeExpiredOutputs } from "@/lib/retention";

export const maxDuration = 300;

/**
 * GET /api/cron/cleanup — deletes generated files older than RETENTION_DAYS (default 7).
 * Cards, prompts and costs are kept; uploaded references are untouched.
 * Protected by CRON_SECRET (Vercel Cron sends it as a Bearer token).
 */
export async function GET(request: Request) {
  const secret = env.cronSecret;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return Response.json(await purgeExpiredOutputs());
}

import "server-only";
import { HttpError, type Actor } from "@/lib/auth";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

const DAY_MS = 24 * 60 * 60 * 1000;

/** What an API key has spent over the last 24 hours. Failed jobs cost nothing on Kie, so they're excluded. */
export async function apiKeySpendLast24h(apiKeyId: string): Promise<number> {
  const { data, error } = await createAdminClient()
    .from("generations")
    .select("cost_usd")
    .eq("api_key_id", apiKeyId)
    .neq("status", "failed")
    .gte("created_at", new Date(Date.now() - DAY_MS).toISOString());
  if (error) throw new HttpError(500, `Could not check API spend: ${error.message}`);
  return (data ?? []).reduce((sum, row) => sum + Number(row.cost_usd ?? 0), 0);
}

export type SpendCapStatus = { cap_usd: number | null; spent_last_24h_usd: number; remaining_usd: number | null };

export async function apiSpendStatus(actor: Actor): Promise<SpendCapStatus | null> {
  if (actor.via !== "api_key" || !actor.apiKeyId) return null;
  const cap = env.apiDailySpendCapUsd;
  const spent = await apiKeySpendLast24h(actor.apiKeyId);
  return {
    cap_usd: cap,
    spent_last_24h_usd: Number(spent.toFixed(4)),
    remaining_usd: cap == null ? null : Number(Math.max(0, cap - spent).toFixed(4)),
  };
}

/**
 * Agents (MCP, scripts) can queue a lot of work quickly, so each API key has a rolling 24-hour
 * budget (API_DAILY_SPEND_CAP_USD, default $500). People using the web app aren't capped.
 */
export async function assertWithinApiSpendCap(actor: Actor, newCostUsd: number | null) {
  const status = await apiSpendStatus(actor);
  if (!status || status.cap_usd == null) return;
  const next = status.spent_last_24h_usd + (newCostUsd ?? 0);
  if (next > status.cap_usd) {
    throw new HttpError(
      402,
      `API spend cap reached: this key has spent $${status.spent_last_24h_usd.toFixed(2)} in the last 24 hours, and this request (~$${(newCostUsd ?? 0).toFixed(2)}) would pass the $${status.cap_usd.toFixed(2)} cap. Ask an admin to raise API_DAILY_SPEND_CAP_USD, or wait.`,
      status,
    );
  }
}

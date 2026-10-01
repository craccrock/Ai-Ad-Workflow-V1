import { providerLabels } from "@/config/models.config";
import { isTransientProviderError, RETRY_LIMIT_PER_STAGE, type RetryRecord } from "@/providers/retry";
import type { ApiGeneration } from "@/lib/client-api";

/** Plain-English status for job cards and toasts. Client-safe (no server imports). */

/** Without history for a model, a job this old counts as slower than usual. */
const DEFAULT_SLOW_MS = { image: 3 * 60 * 1000, video: 10 * 60 * 1000, audio: 5 * 60 * 1000 } as const;
/** Minimum completed jobs before we trust a model's typical time. */
const MIN_SAMPLES = 3;

type Gen = Pick<ApiGeneration, "status" | "provider" | "created_at" | "result_metadata" | "error"> &
  Partial<Pick<ApiGeneration, "model" | "media_type" | "duration_seconds">>;

// ─── typical run times ──────────────────────────────────────────────────────

export type DurationSample = { model: string; duration_seconds: number | string | null; created_at: string; completed_at: string };
/** Seconds, keyed by "model|clip seconds" (videos) and "model" (all of that model's jobs). */
export type TypicalDurations = Record<string, { median: number; p90: number; n: number }>;

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

export function summarizeDurations(samples: DurationSample[]): TypicalDurations {
  const groups: Record<string, number[]> = {};
  for (const s of samples) {
    const secs = (new Date(s.completed_at).getTime() - new Date(s.created_at).getTime()) / 1000;
    if (!(secs > 0)) continue;
    for (const key of [s.model, `${s.model}|${s.duration_seconds != null ? Number(s.duration_seconds) : ""}`]) (groups[key] ??= []).push(secs);
  }
  const out: TypicalDurations = {};
  for (const [key, list] of Object.entries(groups)) {
    if (list.length < MIN_SAMPLES) continue;
    list.sort((a, b) => a - b);
    out[key] = { median: Math.round(quantile(list, 0.5)), p90: Math.round(quantile(list, 0.9)), n: list.length };
  }
  return out;
}

export function typicalFor(gen: Gen, typical?: TypicalDurations) {
  if (!typical || !gen.model) return undefined;
  const clip = gen.duration_seconds != null ? Number(gen.duration_seconds) : "";
  return typical[`${gen.model}|${clip}`] ?? typical[gen.model];
}

/** 110 → "about 1m 50s"; 42 → "about 40s". */
export function formatApprox(seconds: number): string {
  const s = Math.max(10, Math.round(seconds / 10) * 10);
  return `about ${s >= 60 ? `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}` : `${s}s`}`;
}

export const retriesOf = (gen: Pick<ApiGeneration, "result_metadata">) => ((gen.result_metadata?.retries as RetryRecord[] | undefined) ?? []);

/** When the current attempt started: the latest automatic resubmission, else creation. */
export function attemptStartedAt(gen: Pick<ApiGeneration, "created_at" | "result_metadata">): string {
  return (gen.result_metadata?.retried_at as string | undefined) ?? gen.created_at;
}

/** Short label for the provider's error code, e.g. "server error (500)". */
function errorKind(error: string): string {
  const code = error.match(/\b(4\d\d|5\d\d)\b/)?.[1];
  if (/timed? ?out|timeout/i.test(error)) return code ? `timeout (${code})` : "timeout";
  if (code === "429" || /rate/i.test(error)) return "too many requests (429)";
  if (code === "455" || /maintenance/i.test(error)) return "maintenance (455)";
  if (code) return `server error (${code})`;
  return "temporary error";
}

export type InFlightStatus = {
  label: string;
  /** Estimated share done (0–0.95), from elapsed vs. this model's typical time. Undefined without history. */
  progress?: number;
  /** e.g. "Usually takes about 1m 50s". */
  expected?: string;
  notes: string[];
};

/**
 * Kie often reports "waiting" for a job's whole run and then jumps straight to "success", so its state
 * can't tell queueing from generating. The card says "Generating" and measures against what's typical instead.
 */
export function describeInFlight(gen: Gen, now: number, typical?: TypicalDurations): InFlightStatus {
  const provider = providerLabels[gen.provider] ?? gen.provider;
  const elapsed = now - new Date(attemptStartedAt(gen)).getTime();
  const usual = typicalFor(gen, typical);
  const notes: string[] = [];

  const inFlightRetries = retriesOf(gen).filter((r) => r.stage === "in-flight");
  const last = inFlightRetries.at(-1);
  if (last) {
    notes.push(`${provider} hit a ${errorKind(last.error)}, so it was sent again automatically (try ${inFlightRetries.length + 1} of ${RETRY_LIMIT_PER_STAGE + 1}).`);
  }

  const slowAfterMs = usual ? Math.max(usual.p90, usual.median * 1.5) * 1000 : DEFAULT_SLOW_MS[gen.media_type ?? "video"];
  if (elapsed > slowAfterMs) {
    notes.push(`Taking longer than usual, so ${provider} is probably busy. It keeps its place in line; no need to re-run it.`);
  }

  return {
    label: "Generating",
    progress: usual ? Math.min(0.95, elapsed / (usual.median * 1000)) : undefined,
    expected: usual ? `Usually takes ${formatApprox(usual.median)}` : undefined,
    notes,
  };
}

// ─── file retention ─────────────────────────────────────────────────────────

/** Start warning when a file has this many days left. */
const WARN_WITHIN_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ExpiryInfo = {
  /** The file has been cleaned up; the card keeps its prompt, settings and cost. */
  deleted: boolean;
  /** Whole days until deletion (0 = today). Undefined when nothing is scheduled. */
  daysLeft?: number;
  /** Short warning for the card, only close to the deadline. */
  notice?: string;
};

/** Generated files are deleted after `retentionDays`; uploads and the records themselves are kept. */
export function expiryInfo(
  gen: Pick<ApiGeneration, "status" | "completed_at" | "result_url" | "result_metadata">,
  now: number,
  retentionDays?: number | null,
): ExpiryInfo {
  if (gen.result_metadata?.file_deleted_at) return { deleted: true };
  if (!retentionDays || gen.status !== "completed" || !gen.result_url || !gen.completed_at) return { deleted: false };

  const daysLeft = Math.max(0, Math.floor((new Date(gen.completed_at).getTime() + retentionDays * DAY_MS - now) / DAY_MS));
  if (daysLeft > WARN_WITHIN_DAYS) return { deleted: false, daysLeft };
  return { deleted: false, daysLeft, notice: daysLeft === 0 ? "Deletes today" : daysLeft === 1 ? "Deletes tomorrow" : `Deletes in ${daysLeft} days` };
}

/** True while a finished job's file still lives on the provider's host, not ours. */
export function awaitingCopy(gen: Pick<ApiGeneration, "status" | "result_url" | "result_metadata">): boolean {
  if (gen.status !== "completed" || !gen.result_url) return false;
  return Boolean(gen.result_metadata?.provider_url_only) && !gen.result_url.includes("supabase.co");
}

export type FailureInfo = { title: string; advice: string; detail: string };

export function describeFailure(gen: Gen): FailureInfo {
  const detail = gen.error || "No error message was recorded.";
  const provider = providerLabels[gen.provider] ?? gen.provider;
  const onKie = gen.provider === "kie";
  const notCharged = onKie ? " You weren't charged." : "";

  if (/insufficient|credits|balance/i.test(detail) || /\b402\b/.test(detail)) {
    return { title: `${provider} is out of credits`, advice: "Ask an admin to top up the account, then re-run.", detail };
  }
  if (/policy|flagged|sensitive|nsfw|prohibited|filtered|blocked|safety|copyright/i.test(detail)) {
    return { title: "Blocked by the model's safety filter", advice: `Change the prompt or the reference files and try again.${notCharged}`, detail };
  }
  if (/^Timed out/i.test(detail)) {
    return { title: `${provider} never returned this job`, advice: "Try again. If it keeps happening, the provider is having an outage.", detail };
  }
  if (isTransientProviderError(detail)) {
    const retried = retriesOf(gen).length;
    const tried = retried ? ` It was retried automatically ${retried === 1 ? "once" : retried === 2 ? "twice" : `${retried} times`}.` : "";
    return { title: `${provider} had a ${errorKind(detail)}`, advice: `This is on ${provider}'s side, not yours.${tried} Try again in a few minutes.${notCharged}`, detail };
  }
  if (/\b(400|422)\b|invalid|validation/i.test(detail)) {
    return { title: "The model rejected these settings", advice: `Check the reference files and options, then try again.${notCharged}`, detail };
  }
  return { title: "Generation failed", advice: `Try again. If it keeps failing, send Colin a screenshot of this card.${notCharged}`, detail };
}

const TROUBLE_WINDOW_MS = 20 * 60 * 1000;

/**
 * Kie trouble across everyone's recent jobs: server-side failures or automatic retries in the last 20 minutes.
 * Two or more → the gallery shows a heads-up so editors know it's not them.
 */
export function recentProviderTrouble(gens: Gen[], now: number): { provider: string; count: number } | null {
  const count = gens.filter(
    (g) =>
      g.provider === "kie" &&
      now - new Date(g.created_at).getTime() < TROUBLE_WINDOW_MS &&
      ((g.status === "failed" && isTransientProviderError(g.error)) || retriesOf(g).length > 0),
  ).length;
  return count >= 2 ? { provider: providerLabels.kie, count } : null;
}

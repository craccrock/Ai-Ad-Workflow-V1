/**
 * Which provider failures are worth an automatic retry.
 * Kie doesn't charge for failed tasks, so retrying a temporary failure costs nothing but time:
 * an in-flight retry goes to the back of Kie's queue.
 */

export type RetryRecord = {
  at: string;
  /** "submit": Kie rejected the task outright. "in-flight": Kie accepted it, then failed it. */
  stage: "submit" | "in-flight";
  error: string;
  /** The task that failed (in-flight retries only). */
  request_id?: string;
};

/** Retries per stage: up to 2 when Kie rejects a job at submit, and up to 2 more after Kie accepts a job and then fails it. */
export const RETRY_LIMIT_PER_STAGE = 2;

/** " (after a retry)" / " (after 2 retries)" / "" — appended to failure reasons. */
export function afterRetries(count: number): string {
  if (!count) return "";
  return count === 1 ? " (after a retry)" : ` (after ${count} retries)`;
}

const TRANSIENT =
  /\b(408|429|455|500|501|502|503|504|524)\b|timed? ?out|internal error|try again|temporar|unavailable|overload|maintenance|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i;

// Retrying these just fails again: bad key, no credits, bad input, or content rejected.
const PERMANENT = /\b(400|401|402|403|404|422|433|505)\b|insufficient|credits|unauthori[sz]ed|access permission|invalid|validation|policy|sensitive|nsfw|prohibited/i;

export function isTransientProviderError(message: string | undefined | null): boolean {
  if (!message) return false;
  return TRANSIENT.test(message) && !PERMANENT.test(message);
}

/** Rate limits get a longer pause before the retry. */
export function retryDelayMs(message: string): number {
  return /\b429\b|rate/i.test(message) ? 5000 : 2000;
}

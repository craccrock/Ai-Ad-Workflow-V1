import "server-only";
import { canFallback, fallbackModel, type ModelConfig, type NormalizedParams } from "@/config/models.config";
import { elevenLabsProvider } from "./elevenlabs";
import { googleProvider } from "./google";
import { kieProvider } from "./kie";
import { afterRetries, isTransientProviderError, retryDelayMs, RETRY_LIMIT_PER_STAGE, type RetryRecord } from "./retry";
import type { ProviderAdapter, ProviderState, StartContext } from "./types";

/**
 * Provider router. Reads `provider` from the model config and dispatches to the right API.
 * If the primary provider rejects a job with a temporary error, it's retried there first.
 * If it still can't take the job, the model has a `fallback` and the backup is switched on (GOOGLE_BACKUP=on),
 * the job moves to the backup. Nothing above this layer (UI, REST API, gallery, cost tracking) knows which pipe
 * was used beyond the `provider` recorded on the row.
 */
/**
 * The Google backup is off unless GOOGLE_BACKUP=on is set. With it off, jobs stay on Kie and fail with Kie's own
 * error, instead of waiting on a backup that can't run (e.g. no billing on the Google key).
 */
export function backupEnabled(): boolean {
  return process.env.GOOGLE_BACKUP?.trim().toLowerCase() === "on";
}

/** Whether this job may move to the backup provider: switched on, and the backup supports its inputs. */
export function canUseBackup(model: ModelConfig, params: NormalizedParams): boolean {
  return backupEnabled() && canFallback(model, params);
}

function adapterFor(model: ModelConfig): ProviderAdapter {
  switch (model.provider) {
    case "kie":
      return kieProvider;
    case "google":
      return googleProvider;
    case "elevenlabs":
      return elevenLabsProvider;
    default:
      throw new Error(`Unknown provider: ${(model as ModelConfig).provider}`);
  }
}

export type SubmitResult = {
  state: ProviderState;
  /** The model config that actually ran (the fallback variant if we switched). */
  ranOn: ModelConfig;
  /** Why the primary provider was skipped, when a fallback was used. */
  fallbackReason?: string;
  /** Temporary rejections that were retried on the primary before this result. */
  retries: RetryRecord[];
};

export async function submitGeneration(
  model: ModelConfig,
  params: NormalizedParams,
  ctx: StartContext,
  opts: { delayMs?: (error: string) => number } = {},
): Promise<SubmitResult> {
  const adapter = adapterFor(model);
  let state = await adapter.start(model, params, ctx);

  const retries: RetryRecord[] = [];
  while (state.status === "failed" && retries.length < RETRY_LIMIT_PER_STAGE && isTransientProviderError(state.error)) {
    retries.push({ at: new Date().toISOString(), stage: "submit", error: state.error.slice(0, 500) });
    await new Promise((resolve) => setTimeout(resolve, (opts.delayMs ?? retryDelayMs)(state.status === "failed" ? state.error : "")));
    state = await adapter.start(model, params, ctx);
  }

  const backup = canUseBackup(model, params) ? fallbackModel(model) : undefined;
  if (state.status === "failed" && retries.length) state = { ...state, error: `${state.error}${afterRetries(retries.length)}` };
  if (state.status !== "failed" || !backup) return { state, ranOn: model, retries };

  const fallbackReason = `${model.provider}: ${state.error}`;
  const backupState = await adapterFor(backup).start(backup, params, ctx);
  return { state: backupState, ranOn: backup, fallbackReason, retries };
}

/** Start a job directly on the backup provider (used when the primary fails mid-flight). */
export function submitToFallback(model: ModelConfig, params: NormalizedParams, ctx: StartContext): Promise<ProviderState> | null {
  const backup = canUseBackup(model, params) ? fallbackModel(model) : undefined;
  return backup ? adapterFor(backup).start(backup, params, ctx) : null;
}

export function pollGeneration(model: ModelConfig, requestId: string, endpoint: string): Promise<ProviderState> {
  return adapterFor(model).poll(model, requestId, endpoint);
}

import "server-only";
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { z } from "zod";
import { fallbackModel, getModel, type InputType, type ModelConfig, type NormalizedParams } from "@/config/models.config";
import { HttpError, type Actor } from "@/lib/auth";
import { env } from "@/lib/env";
import { actualCost, estimateCost, resolveMode, validateParams } from "@/lib/generation-params";
import { persistOutputFile } from "@/lib/storage";
import { assertWithinApiSpendCap } from "@/lib/spend-cap";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Generation, GenerationWithUser } from "@/lib/types";
import { errorMessage } from "@/lib/utils";
import { afterRetries, isTransientProviderError, RETRY_LIMIT_PER_STAGE, type RetryRecord } from "@/providers/retry";
import { canUseBackup, pollGeneration, submitGeneration, submitToFallback } from "@/providers/router";
import type { ProviderOutput, ProviderState } from "@/providers/types";

const POLL_THROTTLE_MS = 2500;
/** Jobs that never got a provider request id (e.g. function died mid-call) are failed after this. */
const ORPHAN_TIMEOUT_MS = 20 * 60 * 1000;
const FINALIZE_LOCK_MS = 5 * 60 * 1000;
/**
 * If the primary's status checks keep erroring for this long, the job moves to the backup (when it's on).
 * A job that's merely slow (e.g. waiting in Kie's queue) is never moved: Kie would still finish and bill it.
 */
const STATUS_OUTAGE_MS = 15 * 60 * 1000;
/** Absolute cap for any in-flight job, counted from its latest (re)submission. */
const HARD_TIMEOUT_MS = 60 * 60 * 1000;

export const USER_SELECT = "*, user:profiles!generations_user_id_fkey(id, display_name, avatar_url, is_bot)";

export const generateBodySchema = z.object({
  model: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  variants: z.number().int().min(1).max(4).default(1),
  is_shared: z.boolean().default(true),
  /** Validate + estimate only; nothing is generated or billed. */
  dry_run: z.boolean().default(false),
});

export type GenerateBody = z.infer<typeof generateBodySchema>;

// ─── create ─────────────────────────────────────────────────────────────────

/**
 * `dispatch: "inline"` hands the jobs to the provider before returning, instead of in `after()`.
 * A caller that waits for results inside the same request needs it: `after()` callbacks only run
 * once the response has been sent, so waiting on a job that hasn't been dispatched deadlocks.
 */
export async function createGenerations(actor: Actor, body: GenerateBody, opts: { dispatch?: "after" | "inline" } = {}) {
  const model = getModel(body.model);
  if (!model) throw new HttpError(400, `Unknown model "${body.model}". GET /api/models for the list.`);

  const validation = validateParams(model, body.params);
  if (!validation.ok) throw new HttpError(422, "Invalid params", validation.errors);
  const { params, mode } = validation;

  const sourceVideoSeconds = typeof body.params.source_video_duration_seconds === "number" ? body.params.source_video_duration_seconds : undefined;
  const estimate = estimateCost(model, params, body.variants, { sourceVideoSeconds });

  if (body.dry_run) {
    return { model, params, mode, estimate, rows: [] as Generation[] };
  }
  await assertWithinApiSpendCap(actor, estimate.total);

  const batchId = randomUUID();
  const now = new Date().toISOString();
  const rows = Array.from({ length: body.variants }, () => ({
    id: randomUUID(),
    user_id: actor.profile.id,
    batch_id: batchId,
    provider: model.provider,
    provider_endpoint: model.endpoints?.[mode] ?? model.providerModelId,
    model: model.id,
    model_display_name: model.tier ? `${model.name} ${model.tier}` : model.name,
    media_type: model.mediaType,
    status: "queued" as const,
    params,
    prompt: params.prompt ?? null,
    estimated_cost_usd: estimate.perGeneration,
    cost_usd: estimate.perGeneration,
    duration_seconds: params.duration ?? params.audio_duration_seconds ?? null,
    resolution: params.resolution ?? null,
    aspect_ratio: params.aspect_ratio ?? null,
    is_shared: body.is_shared,
    source: actor.via === "api_key" ? ("api" as const) : ("web" as const),
    api_key_id: actor.apiKeyId,
    created_at: now,
  }));

  const admin = createAdminClient();
  const { data, error } = await admin.from("generations").insert(rows).select("*");
  if (error) throw new HttpError(500, `Could not create generation: ${error.message}`);

  // Normally the providers are called after the response is sent, so the client gets job ids instantly.
  const webhookUrl = model.provider === "kie" && env.appUrl ? `${env.appUrl}/api/webhooks/kie` : undefined;
  const send = () => Promise.all((data as Generation[]).map((row) => dispatch(model, row, params, mode, webhookUrl)));
  if (opts.dispatch === "inline") await send();
  else after(send);

  return { model, params, mode, estimate, rows: data as Generation[] };
}

async function dispatch(model: ModelConfig, row: Generation, params: NormalizedParams, mode: InputType, webhookUrl?: string) {
  const admin = createAdminClient();
  try {
    await admin.from("generations").update({ status: "processing" }).eq("id", row.id).eq("status", "queued");
    const { state, ranOn, fallbackReason, retries } = await submitGeneration(model, params, { mode, webhookUrl });
    let current = retries.length ? ((await recordRetries(row, retries)) ?? row) : row;
    if (fallbackReason) current = (await recordFallback(model, current, params, fallbackReason)) ?? current;
    await applyState(ranOn, current, state, fallbackReason);
  } catch (err) {
    await markFailed(row.id, errorMessage(err));
  }
}

type RowMetadata = Record<string, unknown> & { retries?: RetryRecord[]; retried_at?: string };
const metadataOf = (row: Pick<Generation, "result_metadata">) => (row.result_metadata ?? {}) as RowMetadata;

async function recordRetries(row: Generation, retries: RetryRecord[]): Promise<Generation | null> {
  const meta = metadataOf(row);
  const { data } = await createAdminClient()
    .from("generations")
    .update({ result_metadata: { ...meta, retries: [...(meta.retries ?? []), ...retries] } })
    .eq("id", row.id)
    .select("*")
    .maybeSingle();
  return (data as Generation | null) ?? null;
}

/**
 * The primary provider failed a job it had accepted, with a temporary error → resubmit it there
 * (up to RETRY_LIMIT_PER_STAGE times per job).
 * Claims the row by its current request id so concurrent polls can't double-retry.
 */
async function retryOnPrimary(model: ModelConfig, row: Generation, error: string): Promise<Generation> {
  const now = new Date().toISOString();
  const meta = metadataOf(row);
  const retries: RetryRecord[] = [
    ...(meta.retries ?? []),
    { at: now, stage: "in-flight", error: error.slice(0, 500), request_id: row.provider_request_id ?? undefined },
  ];
  const { data } = await createAdminClient()
    .from("generations")
    .update({ provider_request_id: null, status: "processing", last_polled_at: null, result_metadata: { ...meta, retries, retried_at: now } })
    .eq("id", row.id)
    .eq("provider_request_id", row.provider_request_id!)
    .in("status", ["queued", "processing"])
    .select("*")
    .maybeSingle();
  const claimed = data as Generation | null;
  if (!claimed) return row;

  const params = row.params as NormalizedParams;
  const webhookUrl = model.provider === "kie" && env.appUrl ? `${env.appUrl}/api/webhooks/kie` : undefined;
  after(async () => {
    try {
      const { state, ranOn, fallbackReason, retries: submitRetries } = await submitGeneration(model, params, { mode: resolveMode(model, params), webhookUrl });
      let current = submitRetries.length ? ((await recordRetries(claimed, submitRetries)) ?? claimed) : claimed;
      if (fallbackReason) current = (await recordFallback(model, current, params, fallbackReason)) ?? current;
      if (state.status === "failed" && !fallbackReason) {
        return void (await markFailed(row.id, `${model.provider}: ${state.error} — while resubmitting after: ${error}`));
      }
      await applyState(ranOn, current, state, fallbackReason);
    } catch (err) {
      await markFailed(row.id, `${model.provider}: ${error} — retry errored: ${errorMessage(err)}`);
    }
  });
  return claimed;
}

/** The config a row is actually running on: the primary, or its fallback variant after a switch. */
function effectiveModel(model: ModelConfig, row: Pick<Generation, "provider">): ModelConfig {
  return row.provider === model.provider ? model : (fallbackModel(model) ?? model);
}

/**
 * Atomically moves a row from the primary provider to the fallback and re-prices it.
 * Returns null if someone else already switched it (or it finished).
 */
async function recordFallback(model: ModelConfig, row: Generation, params: NormalizedParams, reason: string): Promise<Generation | null> {
  const backup = fallbackModel(model);
  if (!backup) return null;
  const estimate = estimateCost(backup, params, 1, { sourceVideoSeconds: params.source_video_duration_seconds }).perGeneration;
  const { data } = await createAdminClient()
    .from("generations")
    .update({
      provider: backup.provider,
      provider_endpoint: backup.providerModelId,
      provider_request_id: null,
      status: "processing",
      fallback_reason: reason.slice(0, 1000),
      fallback_at: new Date().toISOString(),
      estimated_cost_usd: estimate,
      cost_usd: estimate,
      last_polled_at: null,
    })
    .eq("id", row.id)
    .eq("provider", model.provider)
    .in("status", ["queued", "processing"])
    .select("*")
    .maybeSingle();
  return (data as Generation | null) ?? null;
}

/** Primary failed or stalled mid-flight → re-run once on the fallback, after the current response. */
async function startFallback(model: ModelConfig, row: Generation, reason: string): Promise<Generation> {
  const params = row.params as NormalizedParams;
  if (!canUseBackup(model, params)) return (await markFailed(row.id, reason)) ?? row;
  const switched = await recordFallback(model, row, params, reason);
  if (!switched) return row;
  const backup = fallbackModel(model)!;
  after(async () => {
    try {
      const state = await submitToFallback(model, params, { mode: resolveMode(model, params) });
      if (!state) return void (await markFailed(row.id, reason));
      await applyState(backup, switched, state, reason);
    } catch (err) {
      await markFailed(row.id, `${reason} — backup also failed: ${errorMessage(err)}`);
    }
  });
  return switched;
}

// ─── state transitions ──────────────────────────────────────────────────────

async function applyState(model: ModelConfig, row: Generation, state: ProviderState, fallbackReason?: string): Promise<Generation> {
  const admin = createAdminClient();
  switch (state.status) {
    case "queued":
    case "processing": {
      const { data } = await admin
        .from("generations")
        .update({ status: state.status, provider_request_id: state.requestId, provider_endpoint: state.endpoint })
        .eq("id", row.id)
        .in("status", ["queued", "processing"])
        .select("*")
        .maybeSingle();
      return (data as Generation) ?? row;
    }
    case "failed": {
      const message = fallbackReason ? `${fallbackReason} — backup (${model.provider}) also failed: ${state.error}` : state.error;
      return (await markFailed(row.id, message, state.requestId)) ?? row;
    }
    case "completed":
      return finalize(model, row, state.output, state.requestId);
  }
}

async function markFailed(id: string, message: string, requestId?: string) {
  const { data } = await createAdminClient()
    .from("generations")
    .update({
      status: "failed",
      error_message: message.slice(0, 2000),
      completed_at: new Date().toISOString(),
      cost_usd: 0,
      ...(requestId ? { provider_request_id: requestId } : {}),
    })
    .eq("id", id)
    .in("status", ["queued", "processing"])
    .select("*")
    .maybeSingle();
  return data as Generation | null;
}

/** Copies the output to Storage and marks the row completed. A claim lock prevents double work. */
async function finalize(model: ModelConfig, row: Generation, output: ProviderOutput, requestId?: string): Promise<Generation> {
  const admin = createAdminClient();
  const staleLock = new Date(Date.now() - FINALIZE_LOCK_MS).toISOString();
  const { data: claimed } = await admin
    .from("generations")
    .update({ finalizing_at: new Date().toISOString(), ...(requestId ? { provider_request_id: requestId } : {}) })
    .eq("id", row.id)
    .in("status", ["queued", "processing"])
    .or(`finalizing_at.is.null,finalizing_at.lt.${staleLock}`)
    .select("*")
    .maybeSingle();

  if (!claimed) {
    const { data: current } = await admin.from("generations").select("*").eq("id", row.id).maybeSingle();
    return (current as Generation) ?? row;
  }

  try {
    const [primary, ...others] = output.files;
    let stored: Awaited<ReturnType<typeof persistOutputFile>> | null = null;
    try {
      stored = await persistOutputFile(row.user_id, row.id, primary);
    } catch (err) {
      // Kie URLs survive a while (days), so fall back to them; Google inline data / API-keyed URIs cannot.
      if (!primary.url || primary.fetchHeaders) throw err;
      console.warn(`[generations] storage copy failed for ${row.id}, using provider URL`, err);
    }

    const resultUrl = stored?.url ?? primary.url!;
    // Extra outputs (Suno's second take) are copied too: Kie's own links expire.
    const extras = await Promise.all(
      others.map(async (file, i) => {
        try {
          const copy = await persistOutputFile(row.user_id, row.id, file, `-${i + 2}`);
          return { url: copy.url, path: copy.path };
        } catch (err) {
          console.warn(`[generations] storage copy failed for extra output ${i + 2} of ${row.id}`, err);
          return { url: file.url, path: undefined };
        }
      }),
    );
    const providerMeta = withTrackUrls(output.metadata, [resultUrl, ...extras.map((e) => e.url)]);
    const estimated = row.estimated_cost_usd != null ? Number(row.estimated_cost_usd) : null;
    const cost = actualCost(model, row.params as NormalizedParams, output.usage, estimated);
    const duration = output.usage.outputDurationSeconds ?? row.duration_seconds;

    const { data: updated, error } = await admin
      .from("generations")
      .update({
        status: "completed",
        result_url: resultUrl,
        result_storage_path: stored?.path ?? null,
        result_metadata: {
          // No copy in our storage: the provider's own URL is being used, and it expires (Kie: ~14 days).
          provider_url_only: stored ? undefined : true,
          mime_type: stored?.mimeType ?? primary.mimeType,
          file_size_bytes: stored?.sizeBytes,
          width: primary.width,
          height: primary.height,
          additional_files: extras.map((e) => e.url).filter(Boolean),
          additional_storage_paths: extras.map((e) => e.path).filter(Boolean),
          usage: output.usage,
          provider: providerMeta,
          retries: metadataOf(claimed as Generation).retries,
        },
        cost_usd: cost,
        duration_seconds: duration,
        completed_at: new Date().toISOString(),
        finalizing_at: null,
      })
      .eq("id", row.id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    await admin.from("media").insert({
      user_id: row.user_id,
      type: row.media_type,
      filename: `${row.model_display_name} — ${(row.prompt ?? "untitled").slice(0, 60)}`,
      storage_path: stored?.path ?? "",
      url: resultUrl,
      file_size_bytes: stored?.sizeBytes ?? null,
      metadata: { mime_type: stored?.mimeType ?? primary.mimeType, width: primary.width, height: primary.height, duration_seconds: duration ?? undefined },
      generation_id: row.id,
    });

    return updated as Generation;
  } catch (err) {
    return (await markFailed(row.id, `Finalize failed: ${errorMessage(err)}`)) ?? row;
  }
}

/** Suno reports one entry per take; attach each take's stored URL so callers can match audio ids to files. */
function withTrackUrls(metadata: Record<string, unknown> | undefined, urls: (string | undefined)[]) {
  const tracks = metadata?.tracks;
  if (!metadata || !Array.isArray(tracks)) return metadata;
  return { ...metadata, tracks: tracks.map((t: Record<string, unknown>, i: number) => ({ ...t, url: urls[i] })) };
}

// ─── sync (poll) ────────────────────────────────────────────────────────────

/** Bring an in-flight row up to date with its provider. Safe to call often (throttled + locked). */
export async function syncGeneration(row: Generation, opts: { force?: boolean } = {}): Promise<Generation> {
  if (row.status === "completed" || row.status === "failed") return row;
  const model = getModel(row.model);
  if (!model) return (await markFailed(row.id, `Model "${row.model}" no longer exists in config`)) ?? row;

  const running = effectiveModel(model, row);
  const onPrimary = row.provider === model.provider;
  const meta = metadataOf(row);
  // Timers restart when the job is handed to the backup or resubmitted.
  const startedAt = new Date(row.fallback_at ?? meta.retried_at ?? row.created_at).getTime();
  const age = Date.now() - startedAt;

  if (!row.provider_request_id) {
    if (age > ORPHAN_TIMEOUT_MS) return (await markFailed(row.id, "Timed out before the provider accepted the job")) ?? row;
    return row; // still being dispatched (or a synchronous Google image call is running)
  }

  if (row.finalizing_at && Date.now() - new Date(row.finalizing_at).getTime() < FINALIZE_LOCK_MS) return row;

  const admin = createAdminClient();
  if (!opts.force) {
    const cutoff = new Date(Date.now() - POLL_THROTTLE_MS).toISOString();
    const { data: claimed } = await admin
      .from("generations")
      .update({ last_polled_at: new Date().toISOString() })
      .eq("id", row.id)
      .or(`last_polled_at.is.null,last_polled_at.lt.${cutoff}`)
      .select("id")
      .maybeSingle();
    if (!claimed) return row;
  }

  try {
    const state = await pollGeneration(running, row.provider_request_id, row.provider_endpoint ?? running.providerModelId);

    if (onPrimary && state.status === "failed") {
      const inFlightRetries = (meta.retries ?? []).filter((r) => r.stage === "in-flight").length;
      if (inFlightRetries < RETRY_LIMIT_PER_STAGE && isTransientProviderError(state.error)) {
        return await retryOnPrimary(model, row, state.error);
      }
      const reason = `${model.provider}: ${state.error}${afterRetries(inFlightRetries)}`;
      if (canUseBackup(model, row.params as NormalizedParams)) return await startFallback(model, row, reason);
      if (inFlightRetries) return (await markFailed(row.id, reason, row.provider_request_id)) ?? row;
    }
    if ((state.status === "queued" || state.status === "processing") && age > HARD_TIMEOUT_MS) {
      return (await markFailed(row.id, `Timed out: no result after ${Math.round(age / 60000)} min on ${running.provider}`)) ?? row;
    }

    return await applyState(running, row, state, row.fallback_reason ?? undefined);
  } catch (err) {
    // Transient provider/network errors: leave in-flight and retry next poll — unless it's been down too long.
    console.warn(`[generations] poll failed for ${row.id}:`, errorMessage(err));
    if (onPrimary && canUseBackup(model, row.params as NormalizedParams) && age > STATUS_OUTAGE_MS) {
      return await startFallback(model, row, `${model.provider}: status checks failing (${errorMessage(err)})`);
    }
    if (age > HARD_TIMEOUT_MS) return (await markFailed(row.id, `Timed out: ${errorMessage(err)}`)) ?? row;
    return row;
  }
}

// ─── read helpers ───────────────────────────────────────────────────────────

export function canView(actor: Actor, row: Pick<Generation, "user_id" | "is_shared">) {
  return actor.isAdmin || row.user_id === actor.profile.id || row.is_shared;
}

export function canModify(actor: Actor, row: Pick<Generation, "user_id">) {
  return actor.isAdmin || row.user_id === actor.profile.id;
}

export async function getGenerationForActor(actor: Actor, id: string): Promise<GenerationWithUser> {
  if (!z.uuid().safeParse(id).success) throw new HttpError(404, "Generation not found");
  const { data } = await createAdminClient().from("generations").select(USER_SELECT).eq("id", id).maybeSingle();
  if (!data || !canView(actor, data as Generation)) throw new HttpError(404, "Generation not found");
  return data as GenerationWithUser;
}

/** Public JSON shape for API consumers (Claude). */
export function serializeGeneration(g: GenerationWithUser | Generation) {
  const user = "user" in g ? g.user : undefined;
  return {
    id: g.id,
    job_id: g.id,
    batch_id: g.batch_id,
    status: g.status,
    model: g.model,
    model_display_name: g.model_display_name,
    provider: g.provider,
    media_type: g.media_type,
    prompt: g.prompt,
    params: g.params,
    result_url: g.result_url,
    error: g.error_message,
    estimated_cost_usd: g.estimated_cost_usd != null ? Number(g.estimated_cost_usd) : null,
    cost_usd: g.cost_usd != null ? Number(g.cost_usd) : null,
    duration_seconds: g.duration_seconds != null ? Number(g.duration_seconds) : null,
    resolution: g.resolution,
    aspect_ratio: g.aspect_ratio,
    is_shared: g.is_shared,
    source: g.source,
    fallback_reason: g.fallback_reason,
    user: user ?? undefined,
    user_id: g.user_id,
    result_metadata: g.result_metadata,
    created_at: g.created_at,
    completed_at: g.completed_at,
  };
}

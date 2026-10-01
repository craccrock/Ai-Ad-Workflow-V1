import "server-only";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { HttpError, type Actor } from "@/lib/auth";
import { createGenerations, getGenerationForActor, serializeGeneration, syncGeneration, USER_SELECT } from "@/lib/generations";
import { describeFailure } from "@/lib/job-status";
import { importMediaFromUrl } from "@/lib/media";
import { modelCatalog } from "@/lib/model-catalog";
import { songTiming } from "@/lib/song-timing";
import { apiSpendStatus } from "@/lib/spend-cap";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Generation, GenerationWithUser } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

/**
 * MCP tools for Madaket Gen Studio. Each tool runs as the API key's owner, through the same code
 * as the web app and REST API: same validation, pricing, spend ledger, gallery and library.
 */

/** Vercel caps a request at 300s; leave room for the response. */
const MAX_WAIT_SECONDS = 240;
const POLL_EVERY_MS = 4000;

type ToolContext = { http?: { authInfo?: { extra?: Record<string, unknown> } } };

function actorOf(ctx: ToolContext): Actor {
  const actor = ctx.http?.authInfo?.extra?.actor as Actor | undefined;
  if (!actor) throw new HttpError(401, "Unauthorized — send Authorization: Bearer <API key>");
  return actor;
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

/** Tool errors go back to the model as readable text instead of failing the whole call. */
async function run(ctx: ToolContext, fn: (actor: Actor) => Promise<unknown>) {
  try {
    return json(await fn(actorOf(ctx)));
  } catch (err) {
    const details = err instanceof HttpError && err.details ? `\n${JSON.stringify(err.details, null, 2)}` : "";
    return { content: [{ type: "text" as const, text: `Error: ${errorMessage(err)}${details}` }], isError: true };
  }
}

const isDone = (g: Pick<Generation, "status">) => g.status === "completed" || g.status === "failed";

/** Compact job record for agents: no raw params or avatar URLs, plus a plain-English reason on failure. */
function jobSummary(g: GenerationWithUser | Generation) {
  const { params: _params, user, result_metadata, ...rest } = serializeGeneration(g);
  void _params;
  // Lyric timings can be long; get_song_timing returns them.
  const { lyric_timings, ...metadata } = (result_metadata ?? {}) as Record<string, unknown>;
  return {
    ...rest,
    result_metadata: result_metadata ? { ...metadata, lyric_timings_cached: lyric_timings ? Object.keys(lyric_timings as object) : undefined } : null,
    user: user ? { id: user.id, display_name: user.display_name } : undefined,
    failure: g.status === "failed" ? describeFailure({ ...g, error: g.error_message }) : undefined,
  };
}

async function loadJobs(actor: Actor, ids: string[]) {
  return Promise.all(ids.map((id) => getGenerationForActor(actor, id)));
}

/** Poll (and sync with the provider) until every job finishes or the deadline passes. */
async function waitForJobs(actor: Actor, ids: string[], seconds: number) {
  const deadline = Date.now() + Math.min(seconds, MAX_WAIT_SECONDS) * 1000;
  let rows = await loadJobs(actor, ids);
  for (;;) {
    rows = await Promise.all(rows.map(async (row) => (isDone(row) ? row : { ...(await syncGeneration(row)), user: row.user })));
    if (rows.every(isDone) || Date.now() + POLL_EVERY_MS > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_EVERY_MS));
  }
  const pending = rows.filter((r) => !isDone(r)).length;
  return {
    all_done: pending === 0,
    pending,
    hint: pending ? "Still running. Call wait_for_generations again with the same job_ids." : undefined,
    jobs: rows.map(jobSummary),
  };
}

const paramsSchema = z
  .record(z.string(), z.unknown())
  .describe(
    "Generation params. Common: prompt, aspect_ratio, resolution, duration (seconds), image_urls (image-model references), start_frame_url / end_frame_url (video frames), reference_image_urls / reference_video_urls / reference_audio_urls, audio_url (avatars), video_url (video upscalers), seed. Audio models (Suno, ElevenLabs) take `prompt` (lyrics / script) plus `settings` ({ style, title, duration, voice, … } as listed in that model's options.fields). Allowed values per model come from list_models (options + params_reference).",
  );

export function registerMcpTools(server: McpServer) {
  server.registerTool(
    "list_models",
    {
      title: "List models",
      description:
        "The model catalog: ids, media type, supported options (aspect ratios, durations, resolutions, reference inputs) and pricing, plus a params reference. Call this before generating to pick a model id and valid params.",
      inputSchema: z.object({
        media_type: z.enum(["image", "video", "audio"]).optional().describe("Only return models that output this media type."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ media_type }, ctx) =>
      run(ctx, async () => {
        const catalog = modelCatalog();
        return media_type ? { ...catalog, models: catalog.models.filter((m) => m.media_type === media_type) } : catalog;
      }),
  );

  server.registerTool(
    "estimate_cost",
    {
      title: "Estimate cost",
      description: "Validate params and price a generation without running it or spending anything. Also returns how much of this API key's 24-hour budget is left.",
      inputSchema: z.object({
        model: z.string().describe("Model id from list_models."),
        params: paramsSchema,
        variants: z.number().int().min(1).max(4).default(1),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ model, params, variants }, ctx) =>
      run(ctx, async (actor) => {
        const result = await createGenerations(actor, { model, params, variants, is_shared: true, dry_run: true });
        return { model: result.model.id, mode: result.mode, params: result.params, estimate: result.estimate, budget: await apiSpendStatus(actor) };
      }),
  );

  server.registerTool(
    "generate",
    {
      title: "Generate",
      description:
        "Start an image, video, song or voiceover generation. It appears in the team gallery and spend dashboard like any other job. Returns job ids immediately; set wait_seconds (up to 240) to wait for results in the same call, or call wait_for_generations later. References must be public URLs; use import_media first for files that aren't. Costs real money: check estimate_cost for anything expensive. Each API key has a rolling 24-hour spend cap.",
      inputSchema: z.object({
        model: z.string().describe("Model id from list_models."),
        params: paramsSchema,
        variants: z.number().int().min(1).max(4).default(1).describe("How many takes to generate (each is billed)."),
        is_shared: z.boolean().default(true).describe("Show in the team gallery (default) or keep private to this key's owner."),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(0).describe("Wait up to this long for the jobs to finish before returning."),
      }),
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ model, params, variants, is_shared, wait_seconds }, ctx) =>
      run(ctx, async (actor) => {
        // Waiting in this call means the response hasn't been sent yet, and `after()` work would
        // never start — so when we're about to wait, dispatch before returning.
        const created = await createGenerations(actor, { model, params, variants, is_shared, dry_run: false }, { dispatch: wait_seconds ? "inline" : "after" });
        const ids = created.rows.map((r) => r.id);
        const base = { job_ids: ids, model: created.model.id, estimated_cost_usd: created.estimate.total, budget: await apiSpendStatus(actor) };
        if (!wait_seconds) return { ...base, status: "queued", hint: "Call wait_for_generations with these job_ids to get the results." };
        return { ...base, ...(await waitForJobs(actor, ids, wait_seconds)) };
      }),
  );

  server.registerTool(
    "get_song_timing",
    {
      title: "Get song timing",
      description:
        "Word- and line-level timestamps (seconds) for one take of a finished Suno song, with [Verse]/[Chorus] sections. Use it to cut a storyboard to the song. Suno returns 2 takes per job (take 1 = result_url, take 2 = additional_files[0]). Costs $0.0025 the first time, then cached.",
      inputSchema: z.object({
        job_id: z.string(),
        take: z.number().int().min(1).max(2).default(1),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ job_id, take }, ctx) => run(ctx, (actor) => songTiming(actor, job_id, take)),
  );

  server.registerTool(
    "wait_for_generations",
    {
      title: "Wait for generations",
      description: "Wait until the given jobs finish (or timeout_seconds passes) and return their status, result URLs, costs and any failure reasons. Safe to call repeatedly.",
      inputSchema: z.object({
        job_ids: z.array(z.string()).min(1).max(20),
        timeout_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(MAX_WAIT_SECONDS),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ job_ids, timeout_seconds }, ctx) => run(ctx, (actor) => waitForJobs(actor, job_ids, timeout_seconds)),
  );

  server.registerTool(
    "get_generations",
    {
      title: "Get generations",
      description: "Current status of specific jobs, without waiting.",
      inputSchema: z.object({ job_ids: z.array(z.string()).min(1).max(50) }),
      annotations: { readOnlyHint: true },
    },
    async ({ job_ids }, ctx) => run(ctx, (actor) => waitForJobs(actor, job_ids, 0)),
  );

  server.registerTool(
    "list_generations",
    {
      title: "List generations",
      description: "Recent generations from the team gallery (own + shared), newest first.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(20),
        model: z.string().optional(),
        media_type: z.enum(["image", "video", "audio"]).optional(),
        status: z.enum(["queued", "processing", "completed", "failed"]).optional(),
        mine_only: z.boolean().default(false).describe("Only jobs created by this API key's owner."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, model, media_type, status, mine_only }, ctx) =>
      run(ctx, async (actor) => {
        let query = createAdminClient().from("generations").select(USER_SELECT).order("created_at", { ascending: false }).limit(limit);
        if (!actor.isAdmin) query = query.or(`user_id.eq.${actor.profile.id},is_shared.eq.true`);
        if (mine_only) query = query.eq("user_id", actor.profile.id);
        if (model) query = query.eq("model", model);
        if (media_type) query = query.eq("media_type", media_type);
        if (status) query = query.eq("status", status);
        const { data, error } = await query;
        if (error) throw new HttpError(500, error.message);
        return { jobs: (data as GenerationWithUser[]).map(jobSummary) };
      }),
  );

  server.registerTool(
    "import_media",
    {
      title: "Import media",
      description:
        "Copy an image, video or audio file from a URL into the team Media Library and return its stable public URL, ready to use as a reference (image_urls, start_frame_url, reference_*_urls, audio_url, video_url). Kie deletes its own outputs after 14 days, so import anything you'll reuse.",
      inputSchema: z.object({
        url: z.url().describe("Publicly reachable file URL."),
        filename: z.string().max(300).optional(),
      }),
      annotations: { openWorldHint: true },
    },
    async ({ url, filename }, ctx) =>
      run(ctx, async (actor) => {
        const media = await importMediaFromUrl(actor, { url, filename });
        return { id: media.id, type: media.type, url: media.url, filename: media.filename, file_size_bytes: media.file_size_bytes };
      }),
  );

  server.registerTool(
    "list_media",
    {
      title: "List media",
      description: "Files in the team Media Library (uploads and generated outputs), newest first. Their URLs can be used as references.",
      inputSchema: z.object({
        type: z.enum(["image", "video", "audio"]).optional(),
        source: z.enum(["uploads", "generated"]).optional(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ type, source, limit }, ctx) =>
      run(ctx, async () => {
        let query = createAdminClient()
          .from("media")
          .select("id, type, filename, url, file_size_bytes, generation_id, created_at")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (type) query = query.eq("type", type);
        if (source === "uploads") query = query.is("generation_id", null);
        if (source === "generated") query = query.not("generation_id", "is", null);
        const { data, error } = await query;
        if (error) throw new HttpError(500, error.message);
        return { media: data };
      }),
  );

  server.registerTool(
    "get_budget",
    {
      title: "Get budget",
      description: "How much this API key has spent in the last 24 hours and how much of its cap is left.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async (_args, ctx) =>
      run(ctx, async (actor) => (await apiSpendStatus(actor)) ?? { note: "Not an API-key session; no cap applies." }),
  );
}

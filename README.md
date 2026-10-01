# Madaket Gen Studio

> **Setting up for the first time? Start with [SETUP.md](SETUP.md).** Editors: see [EDITOR-GUIDE.md](EDITOR-GUIDE.md).

An internal image and video generation studio for Madaket Brands. Colin, the editors and Claude all use the same UI or API, share one generation history and one cost ledger. Behind that:

| Provider | Role | Models |
|---|---|---|
| **Kie.ai** | Primary for everything. Cheapest per generation as of Sept 2026 (see pricing comparison). | Gemini Omni Flash 1.1, Nano Banana Pro / 2 / 2 Lite, Kling 3.0 (Std/Pro/4K), Kling 2.6, Seedance 2.0 (Fast/Pro), Hailuo H3, Kling AI Avatar (Std/Pro), Suno V6 (songs), ElevenLabs Voice (Multilingual v2 / Turbo 2.5) + Dialogue v3, Flux 2 Pro, Seedream 5 (Lite/Pro), Recraft Crisp + Topaz upscalers |
| **ElevenLabs (direct)** | Voiceovers and dialogue. Not through Kie: its ElevenLabs endpoints were returning 500s, and direct reaches the account's own voice library (clones included). Synchronous — audio comes back in the response. | Eleven v3, Multilingual v2, Flash 2.5, Dialogue |
| **Google Gemini API (direct)** | Optional backup for the Google models only. **Off** unless `GOOGLE_BACKUP=on` is set. | Omni Flash 1.1, Nano Banana Pro / 2 / 2 Lite |

**Retries.** Kie doesn't charge for failed tasks, so temporary Kie errors (500, 524 timeouts, 429, 455 maintenance, network errors) are retried automatically: up to 2 times when Kie rejects a job at submit, and up to 2 more times when Kie accepts a job and then fails it. Each in-flight retry goes to the back of Kie's queue. Permanent errors (no credits, bad input, content filter) are never retried. A job with no result 60 minutes after its latest submission is marked failed.

**Status on cards.** Kie often reports `waiting` for a job's whole run and then jumps to `success`, so its state can't separate queueing from generating. Cards say "Generating" with an estimated progress bar and "Usually takes about…", based on the median time of that model's completed jobs over the last 30 days (per clip length for videos; `src/lib/typical-durations.ts`). A "taking longer than usual" note appears past the 90th percentile, and another after an automatic retry. Failed cards explain the error in plain English (`src/lib/job-status.ts`), and the gallery shows a heads-up when 2+ recent jobs hit Kie errors.

**Backup rules (when `GOOGLE_BACKUP=on`).** A Google model's job moves to Google direct (once) when Kie rejects it at submit, fails it after the retries, or its status API keeps failing for 15 minutes. Jobs that are merely slow in Kie's queue are never moved, since Kie would still finish and bill them. The card shows a **Backup** badge, the row records `fallback_reason`, and cost switches to Google's price. Kie-only models have no backup. Only turn it on once billing is enabled on the Google key; otherwise Google refuses every backup job.

**Bandwidth.** Outputs are 5–7 MB originals, and Supabase Storage egress is metered, so nothing in a grid loads an original: image thumbnails go through Next's optimizer (`ImageThumb`, allow-listed in `next.config.ts`, resized copies cached 31 days), video cards show their first frame and only stream on hover (`VideoThumb`), and stored files are written with a one-year `Cache-Control` (`IMMUTABLE_CACHE`). Full-size files are fetched only when someone opens or downloads one. One gallery page dropped from ~160 MB to ~5 MB.

Routing is driven entirely by `provider` and `fallback` in [`src/config/models.config.ts`](src/config/models.config.ts). That file is the only place models are defined: the UI, the cost estimates, API validation and routing all read from it.

---

## Setup

### 1. Supabase
1. Create a project at supabase.com.
2. Apply the schema. Either run `supabase db push` with the CLI linked, or paste **both** files in [`supabase/migrations/`](supabase/migrations/) into the SQL editor, in filename order (`…_init.sql`, then `…_kie_provider.sql`). Together they create:
   - tables
   - row-level security (RLS) policies
   - the profile trigger
   - the `media` and `generations` storage buckets
   - the `spend_stats()` function
3. **Authentication → Sign In / Providers → Email:** turn **off** "Allow new users to sign up". Only admins create accounts.

**Accounts without email.** Admins add people on **Team & API**. The account is created with a random temporary password, shown once, and flagged in `app_metadata.must_change_password`. `requireSessionProfile()` sends flagged users to `/set-password` until they choose their own password, and that page clears the flag with the service role. **Reset password** issues a new temporary one. No SMTP is needed.

To add self-serve reset emails later: configure custom SMTP in Supabase, set the Site URL and `/auth/confirm` redirect URL, and use the templates `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/set-password`. `/auth/confirm` already handles these links.

### 2. Environment
```bash
cp .env.example .env.local   # fill in every value
```

### 3. First admin
```bash
npm install
npm run create-admin -- you@madaketbrands.com "Colin Crowley"
npm run dev
```

### 4. Deploy (Vercel)
1. Import the repo and add the same environment variables.
2. `NEXT_PUBLIC_APP_URL` is detected automatically on production deploys. Set it explicitly if you use a custom domain.
3. Routes use `maxDuration = 300`, which works on every Vercel plan with Fluid Compute (the default on new projects).
4. *Optional:* add a cron job that sweeps jobs nobody is polling. It needs Vercel Pro for sub-daily schedules and `CRON_SECRET` set:
   ```json
   { "crons": [{ "path": "/api/cron/sync", "schedule": "*/5 * * * *" }] }
   ```

---

## How a generation flows

```
POST /api/generate ──► insert row(s) status=queued ──► 202 { job_id }   (instant)
                              │
                         after() ──► providers/router.ts
                                        ├─ kie: jobs/createTask → taskId (+ callBackUrl)
                                        │    rejected? ──► google (if the model has a fallback)
                                        └─ google: Interactions API
                                             images → sync, finalize immediately
                                             video  → background interaction id

GET /api/generate/:id/status ──► poll the provider the row is on ──► on completion:
      claim lock → copy output into Supabase Storage → real cost → status=completed
      failed / stalled on kie? ──► claim + switch row to google ──► re-run once
```

- **One status endpoint.** The UI polls `/api/generate/:id/status` whatever the provider.
- **Kie callbacks.** When `NEXT_PUBLIC_APP_URL` is set, Kie's callback finishes jobs even if nobody is polling. The callback body is only a hint: the job is always re-checked against Kie before it's updated.
- **Outputs are copied to our storage.** Kie deletes media after 14 days, and Google's URIs need an API key to fetch.
- **Costs.** The estimate is stored when the job is submitted and replaced with the actual cost on completion where possible:
  - Kie: `creditsConsumed` × $0.005.
  - Google video (backup): output tokens × $17.50/M.
- **Spend excludes failed jobs.**

---

## MCP server (for Claude and other agents)

`POST /api/mcp` is a remote MCP server (Streamable HTTP, via `mcp-handler`), authenticated with the same API keys as the REST API. Tools run as the key's owner through the same code paths, so jobs show up in the gallery and spend ledger like any other.

| Tool | What it does |
|---|---|
| `list_models` | Catalog with options, reference inputs, pricing and a params reference |
| `estimate_cost` | Validate + price without spending; includes remaining budget |
| `generate` | Start jobs; optional `wait_seconds` (≤ 240) to return results in the same call |
| `wait_for_generations` / `get_generations` | Poll jobs (syncs with Kie); failures include a plain-English reason |
| `list_generations` | Recent gallery items (own + shared) |
| `import_media` / `list_media` | Copy a URL into the library for use as a reference / browse the library |
| `get_budget` | This key's spend in the last 24h vs. its cap |
| `get_song_timing` | Word and line timestamps (with `[Verse]`/`[Chorus]` sections) for a finished Suno take, for cutting video to the song |

**Spend cap.** Every API key (MCP or REST) has a rolling 24-hour cap, `API_DAILY_SPEND_CAP_USD` (default $500, `off` to disable). A request that would pass it is refused before anything is submitted. Web-app users aren't capped.

Connect Claude Code:
```bash
claude mcp add --transport http --scope user madaket https://madaket-gen-studio.vercel.app/api/mcp --header "Authorization: Bearer mgs_…"
```
Clients that only speak stdio can use `npx -y mcp-remote https://…/api/mcp --header "Authorization: Bearer mgs_…"`. claude.ai / Claude Desktop "custom connectors" need OAuth, which isn't implemented yet.

## API (for Claude / MCP / scripts)

Create an API identity (e.g. "Claude") and a key under **Team & API**. Every request takes:
```
Authorization: Bearer mgs_…
```

### `GET /api/models`
Returns the model catalog (ids, options, pricing, required inputs) and a params reference.

### `POST /api/generate`
```json
{
  "model": "kling-avatar-standard",
  "params": {
    "prompt": "A woman talking about skincare benefits",
    "image_url": "https://…",
    "audio_url": "https://…",
    "audio_duration_seconds": 10
  },
  "variants": 1,
  "dry_run": false
}
```
- `model` takes either our id (see `GET /api/models`) or a provider model string, e.g. `kling/ai-avatar-standard`.
- `dry_run: true` validates the request and returns a cost estimate without generating anything.
- **Video references:** `start_frame_url` / `end_frame_url`, or `reference_image_urls` / `reference_video_urls` / `reference_audio_urls` (with `*_durations` in seconds), per each model's `options.references` in `GET /api/models`. Most models take frames *or* references, not both. Kling 3.0 also takes `elements: [{ name, image_urls }]`, referenced as `@name` in the prompt.
- **Audio models** take `prompt` plus `params.settings`, whose keys, types, defaults and allowed values are each model's `options.fields` in `GET /api/models`:
  - `suno`: `prompt` = lyrics (`settings.mode: "custom"`, the default) or a song description (`"describe"`); `settings: { style, title, duration (10–360 s), instrumental, vocal_gender, version }`. Each job returns **2 takes**: `result_url` and `result_metadata.additional_files[0]`; `result_metadata.provider.tracks` has each take's Suno `audio_id` and length. Both takes are copied to Storage.
  - `elevenlabs-tts` / `elevenlabs-tts-turbo`: `prompt` = the script (≤ 5000 chars); `settings: { voice, speed, stability, similarity_boost, style }` (+ `language_code` on Turbo). Voices are Kie's 67 presets (`src/config/elevenlabs-voices.ts`). Priced per 1,000 characters.
  - `elevenlabs-dialogue`: `prompt` is one turn per line, `Voice name: line` (preset names, e.g. `Liam: …`).
- `GET /api/generate/:job_id/lyrics?take=1` (MCP: `get_song_timing`) returns a Suno take's lyric timings: `lines: [{ section, text, start, end }]` and `words`. Kie charges 0.5 credits the first time (not counted in the spend ledger); the result is cached on the job.
- `params.extra` is merged into the Kie `input` last. Use it for Kie fields not surfaced in the UI (it is not applied if the job falls back to Google).

Response `202`:
```json
{ "job_id": "uuid", "job_ids": ["uuid"], "status": "queued", "estimated_cost_usd": 0.4, "jobs": [ … ] }
```
Validation errors come back as `422` with a `details` array of human-readable messages.

### Checking a job
- `GET /api/generate/:job_id` returns the full record: `status`, `result_url`, `cost_usd`, `error`, `provider`, `fallback_reason`, …
- `GET /api/generate/:job_id/status` returns `{ status, resultUrl?, error?, costUsd? }`.

Poll every 3–5 seconds. Images usually finish in under 30 seconds; video takes 1–5 minutes.

### `GET /api/generations`
Paginated history, the same data the gallery shows.
- **Filters:** `model`, `media_type`, `user_id`, `status`, `from`, `to` (YYYY-MM-DD), `mine=true`
- **Paging and order:** `page`, `limit` (≤50), `sort=newest|oldest|cost`

### Media
- `GET /api/media?type=image|video|audio&source=uploads|generated`
- `POST /api/media` with `{ "url": "https://…" }` copies a remote file into the library and returns its stable `url`.
- `POST /api/media/upload-url` with `{ filename, content_type }` returns a signed URL for large files. PUT the file there, then register it with `POST /api/media { storage_path, filename, type }`.
- `DELETE /api/generate/:id` deletes a generation. `DELETE /api/media/:id` deletes an upload.

---

## ElevenLabs

`src/providers/elevenlabs.ts` calls `POST /v1/text-to-speech/{voice_id}` (and `/v1/text-to-dialogue` for multi-voice) with `ELEVENLABS_API_KEY`, and returns MP3 bytes that `finalize` stores like any other output. The voice picker is filled at page load from `GET /v2/voices` (`accountVoices()`, cached 10 minutes), so cloned and library voices appear automatically; `FieldSpec.optionsFrom: "voices"` marks a field as account-supplied, which also makes server-side validation skip its allowed-values check. Dialogue scripts are `"Voice: line"` per turn, resolved against the account library by name or id, capped at 2,000 characters by ElevenLabs.

Prices in the config are ElevenLabs' published per-character rates ($0.10 per 1,000 characters for v3 and Multilingual v2, $0.05 for Flash); in practice those characters come out of the monthly plan allowance, so the Spend page overstates what a subscriber actually pays.

## File retention

A daily cron (`/api/cron/cleanup`, scheduled in `vercel.json`) deletes generated files older than `RETENTION_DAYS` (default 7, `off` disables). It removes the object from the `generations` bucket plus any extra takes, deletes the library row, and blanks `result_url` / `result_storage_path` while stamping `result_metadata.file_deleted_at`. The generation row itself — prompt, params, cost, timings — is kept, so the Spend page stays accurate and ↻ still works. Uploaded references in the `media` bucket are never touched. Cards count down from two days out (`expiryInfo` in `src/lib/job-status.ts`) and then show "File removed".

Both crons need `CRON_SECRET` set in Vercel; without it the endpoints return 401 and nothing is swept or deleted. Vercel Hobby runs crons once a day.

## WebP downloads

Model outputs are large PNGs (8 MB is typical). Cards, the library detail pane and the bulk zip all offer a WebP copy, converted in the browser at full resolution via canvas at quality 0.9 (`src/lib/webp.ts`); measured on Nano Banana Pro output, 8.0 MB → 0.7 MB. Stored originals are untouched, and anything that won't convert falls back to the original file.

## Bulk selection in the gallery
Hover a card → checkbox (top-right); shift-click extends the range from the last click; **Select all** takes the loaded page. Actions: **Download zip** and **Delete**.

The zip is built in the browser (`src/lib/zip.ts`, fflate, stored level 0) because a server-built zip would exceed Vercel's 4.5 MB response limit. Delete reuses `DELETE /api/generate/:id` per item and skips generations the user can't modify, reporting how many were skipped.

## Adding or re-pricing a model
Edit `src/config/models.config.ts`, then run `npm test` to check it. The tests assert:
- every model has a price for every selectable option, on Kie and on its backup
- every default is valid
- every Kie model has a `mapInput`
- only Google models have a Google backup

Kie prices are written as credits with `cr(…)` (1 credit = $0.005). For a new Kie model:
1. Copy a similar entry.
2. Set `providerModelId` to Kie's `model` string, plus `endpoints` if Kie uses separate strings for text vs image input.
3. Write `mapInput` to translate the normalized params into that model's `input` schema. The schema is on the model's page at docs.kie.ai.
4. Only add a `fallback` when Google direct can run the same model with the same options.

## Scripts
| | |
|---|---|
| `npm run dev` | local dev server |
| `npm run build` | production build |
| `npm run lint` / `npm run typecheck` | static checks |
| `npm test` | model config, pricing, Kie adapter and fallback-routing tests |
| `npm run create-admin -- <email> "<name>"` | bootstrap or promote an admin |
| `npm run set-password -- <email>` | set any account's password (lockout recovery) |

## Known gaps / next steps
- **Omni Flash duration on the Google backup.** The Interactions API types `response_format.duration` as a string but doesn't document the format. We send `"8s"`. If Google rejects it, change `omniDuration()` in `src/providers/google.ts`.
- **Kie avatar version.** Kie's Kling AI Avatar pages don't say whether it is v1 or v2.
- **Runway** is available on Kie (`model: "runway"`), but its status/callback shape differs from the other models, so it isn't wired up yet.
- **ElevenLabs on Kie was failing** every test call with "Internal Error" (no charge) on 2026-09-25, while Suno worked. The models are wired per Kie's docs; confirm with one real generation. Where word timestamps land in the result (`timestamps: true`) is undocumented, so they aren't exposed yet; use Whisper on the file instead.
- **More Suno tools on Kie**, not wired up yet: extend, cover, add vocals / instrumental, stem separation, replace section, and Suno Sounds (loops/stingers). Same createTask API; each is a small config entry plus its inputs.
- **Kie callback signatures** (HMAC) aren't verified; the callback is only used as a hint to re-poll, so this isn't a security gap.
- **Google Batch API** (~50% off Nano Banana). Rates are already in the config as `batchRates`, but the Batch API isn't wired up yet. It's a good fit for bulk static-ad runs that don't need instant results.

# Read me first

This folder is a complete copy of Gen Studio: an internal image, video and voiceover tool for a small team. It's a Next.js app that runs on Vercel, stores everything in Supabase, and generates through [Kie.ai](https://kie.ai) (which resells most good models cheaper than going direct) plus ElevenLabs for voice.

**No API keys or passwords are included.** You'll create your own accounts, and your copy is completely separate from the original — separate database, separate billing, separate logins.

## What you get

- **28 models** behind one form, with a live price estimate before you hit Generate:
  - **Images:** Nano Banana Pro / 2 / 2 Lite, GPT Image 2, GPT Image 2.5 (Flare + Sunburst), Flux 2 Pro, Seedream 5
  - **Video:** Gemini Omni Flash 1.1, Kling 3.0 (Standard/Pro/4K), Kling 2.6, Seedance 2.0 (Fast/Pro), Seedance 2.5, Hailuo H3
  - **Voice & music:** ElevenLabs (v3, Multilingual v2, Flash 2.5, two-person Dialogue), Suno
  - **Talking heads:** Kling AI Avatar; **Upscalers:** Recraft, Topaz
- A shared gallery with filters, multi-select, zip download, and WebP downloads (about 90% smaller than the original PNG).
- A media library for reference images, voiceovers and every output.
- Logins for your team, with temporary passwords you hand out — no email service needed.
- A spend dashboard by day, model and person.
- A REST API and an **MCP server**, so Claude can generate for you, with a per-key daily spend cap.
- Automatic housekeeping: generated files are deleted after 7 days (configurable), failed provider jobs are retried, and slow file transfers are re-copied in the background.

## What it costs

| Thing | Cost |
|---|---|
| Kie.ai | pay as you go — about 2–10¢ an image, 15¢–$1.20 a video |
| ElevenLabs | optional, for voice — your existing plan works; API usage comes out of the same monthly characters |
| Supabase | free to start; **$25/month** once you store more than 1 GB (that's ~150 generated images) |
| Vercel | free for personal use; **$20/month** for business use |
| Google AI key | optional backup, off by default |

## Setting it up

Follow **SETUP.md** start to finish — written for someone who has never used a terminal, about an hour, most of it waiting. Short version:

1. **Accounts and keys:** Kie.ai, Supabase, and optionally ElevenLabs and Google.
2. **Database:** run the three files in `supabase/migrations/` **in filename order** in Supabase's SQL Editor. ("Success. No rows returned" is what success looks like.)
3. **Local test:** copy `.env.example` to `.env.local`, fill it in, `npm install`, `npm run dev`.
4. **Create your admin login:** `npm run create-admin`.
5. **Deploy:** push to GitHub, import into Vercel, paste the same environment variables.

The easiest route is to open this folder in [Claude Code](https://claude.com/claude-code) and say: *"Set this up for me, following SETUP.md."* It can run the commands and fill in the gaps.

### Environment variables

| Name | Needed? | What it does |
|---|---|---|
| `KIE_API_KEY` | **yes** | Every model except the ElevenLabs ones |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | **yes** | Database, logins, file storage |
| `API_SECRET_SALT` | **yes** | Hashes API keys. Never change it after creating keys |
| `ELEVENLABS_API_KEY` | for voice | Voiceovers, and your own voice library appears in the form |
| `CRON_SECRET` | recommended | Without it the daily cleanup and status sweep can't run |
| `NEXT_PUBLIC_APP_URL` | on a custom domain | Where providers send completion callbacks |
| `RETENTION_DAYS` | optional | Days to keep generated files (default 7, `off` to keep everything) |
| `API_DAILY_SPEND_CAP_USD` | optional | Per-API-key daily ceiling (default $500, `off` to remove) |
| `GOOGLE_AI_API_KEY` + `GOOGLE_BACKUP=on` | optional | Falls back to Google for the Gemini models. Needs billing enabled on that key |
| `SPEND_TIMEZONE` | optional | Day boundaries on the Spend page |

### Letting Claude use it

Once the site is live, create an API key (Team & API → API keys), then:

```bash
bash connect-claude-mcp.sh https://your-site.vercel.app
```

Start a new Claude Code session in this folder and approve the server. Claude can then list models, estimate costs, generate, wait for results, and pull files into the library — capped by `API_DAILY_SPEND_CAP_USD` per key per day.

## Making it yours

| What | Where |
|---|---|
| App name | `src/app/layout.tsx`, `src/app/(auth)/layout.tsx`, `src/components/nav.tsx`, `package.json` |
| Logo and favicon | `public/madaket-dog-sketch.png` — replace it, then update those three files |
| Colours and fonts | `src/app/globals.css` (navy/cream/gold tokens; Playfair Display, Inter, JetBrains Mono) |
| "Send Colin a screenshot" | `src/lib/job-status.ts` |
| Mentions of Madaket/Colin in the guides | `README.md`, `SETUP.md`, `EDITOR-GUIDE.md` |

Ask Claude Code to *"rebrand this to <name>, colours <hex>"* and it can do the lot in one pass.

## Adding or changing models

Everything lives in `src/config/models.config.ts` — prices, options, reference inputs, and how inputs map to the provider. The form, cost estimates, validation and the API all read from it. Add a model there, run `npm test`, and it shows up everywhere. Prices are in Kie credits (1 credit = $0.005) and were correct in **October 2026** — check Kie's pricing page before trusting them.

## Things worth knowing

- **Providers break.** Kie's ElevenLabs endpoints returned 500s for a week; Omni Flash had a bad day at 720p while 1080p was fine. The app retries temporary failures twice, explains failures in plain English, and never charges you for a failed job (Kie doesn't bill them).
- **Kie's file host can stall.** Outputs are copied into your own storage; if that copy fails the card says "Finishing up" and the app keeps retrying in the background rather than showing a half-loaded image.
- **Kie deletes its own files after 14 days**, which is why everything is copied to your storage.
- **Storage adds up fast** — roughly 6 MB per image. The 7-day cleanup keeps it bounded; cards keep their prompt and cost after the file goes.
- **EDITOR-GUIDE.md** is written for your team, not for you. Send it once they can log in.
- **README.md** is the technical tour: how a job flows, the API, known gaps.

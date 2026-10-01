# Madaket Gen Studio — Setup Guide

This guide takes you from these files to a live site for you and your editors. Expect about an hour. Do the parts in order: some steps need values from earlier ones.

**What you end up with:**
- A private website, e.g. `https://madaket-gen-studio.vercel.app`.
- You're the admin. You add editors yourself and send them a temporary password.
- Every generation goes through **Kie.ai**. Nano Banana and Omni Flash jobs fall back to **Google direct** automatically if Kie fails.
- All results, uploads and spend are stored in **Supabase**.

---

## Before you start

### Accounts
Make sure you have (or create) these:

| Service | What it's for | Cost to start |
|---|---|---|
| [GitHub](https://github.com) | Stores the code so Vercel can deploy it | Free |
| [Supabase](https://supabase.com) | Database, logins, file storage | Free (Pro $25/mo later) |
| [Vercel](https://vercel.com) | Runs the website | Free Hobby, or Pro $20/mo* |
| [Kie.ai](https://kie.ai) | Generates every image and video | Prepaid credits |
| [Google AI Studio](https://aistudio.google.com) | Backup for Nano Banana and Omni Flash | Pay as you go |

\* Vercel's terms say Hobby is for non-commercial use, so Pro is the proper plan for a business tool. Hobby works technically.

### On your computer
- **Node.js 20 or newer.** It's already installed on your Mac; check with `node -v`. On another computer, install the LTS version from [nodejs.org](https://nodejs.org).
- **Your project folder.** These instructions assume it's at `~/Claude/madaket-gen-studio`. If you unzipped it somewhere else, use that path instead.

> **Keep a notes file open** (ideally in your password manager). You'll collect about 6 keys and URLs along the way. **Never paste secret keys into chat, email or Slack.**

---

## Part 1 — Get your AI keys

### 1a. Kie.ai (main provider)
1. Sign in at [kie.ai](https://kie.ai) and add credits. $10–25 is plenty for testing; credits never expire.
2. In the Kie dashboard, open **API Keys** and create a key. Save it as **`KIE_API_KEY`**.
3. **Recommended:** on that key, set a daily spending limit (for example $50), so a mistake can't burn through credits.

### 1b. ElevenLabs (voiceovers, optional)
1. Sign in at [elevenlabs.io](https://elevenlabs.io) and open [Settings → API Keys](https://elevenlabs.io/app/settings/api-keys).
2. Click **Create API Key**, name it `Madaket Gen Studio`, and set a credit limit so the app can only use part of your monthly allowance.
3. Save it as **`ELEVENLABS_API_KEY`**.
4. Voiceovers use your ElevenLabs plan's characters, and every voice in your library — including clones — shows up in the form automatically.

### 1b. Google (backup)
1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and click **Create API key**.
2. Save it as **`GOOGLE_AI_API_KEY`**.
3. Make sure **billing is turned on** for the Google Cloud project behind that key. Omni Flash only works on the paid tier.
4. The backup stays **off** until you add the Vercel variable `GOOGLE_BACKUP` = `on` (then redeploy). Only do that once billing works.

### 1c. A random secret
Open **Terminal** and run:
```bash
openssl rand -hex 32
```
Save the output as **`API_SECRET_SALT`**. The app uses it to protect API keys. Once it's set, never change it.

---

## Part 2 — Set up Supabase

### 2a. Create the project
1. At [supabase.com/dashboard](https://supabase.com/dashboard), click **New project**.
2. Name it `madaket-gen-studio` and choose **East US** as the region (it's close to Vercel's servers).
3. Set a strong database password, save it, and wait about 2 minutes for the project to start.

### 2b. Create the database
1. In the left sidebar, open **SQL Editor** and click **New query**.
2. Open `supabase/migrations/20260914000000_init.sql` from your project folder in any text editor. Copy **all** of it, paste it into the query, and click **Run**. You should see "Success. No rows returned".
3. Click **New query** again. Paste all of `supabase/migrations/20260914120000_kie_provider.sql` and click **Run**.

The two files must run in that order.

### 2c. Copy your Supabase keys
Go to **Project Settings → API Keys** and save:

| Supabase shows | Save it as |
|---|---|
| Project URL (e.g. `https://abcd1234.supabase.co`) | `NEXT_PUBLIC_SUPABASE_URL` |
| **Publishable** key (starts `sb_publishable_`), or the legacy **anon** key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| **Secret** key (starts `sb_secret_`), or the legacy **service_role** key | `SUPABASE_SERVICE_ROLE_KEY` |

⚠️ The secret key can read and change everything in your database. Treat it like a bank password.

### 2d. Turn off public sign-ups
Go to **Authentication → Sign In / Providers** and turn **off** "Allow new users to sign up". Now only people you add on the Team page can get in.

---

## Part 3 — Test it on your Mac (recommended)

This catches key typos before anything goes live.

1. **Open the project and install its libraries** (takes about a minute):
   ```bash
   cd ~/Claude/madaket-gen-studio && npm install
   ```
2. **Create your settings file.** This makes a private `.env.local` file and opens it in TextEdit:
   ```bash
   cp .env.example .env.local && open -e .env.local
   ```
3. **Fill in the values from Parts 1 and 2** right after each `=` sign, with no spaces, quotes or trailing comments. For example:
   ```
   KIE_API_KEY=abc123...
   ```
   Leave `NEXT_PUBLIC_APP_URL` blank. Save and close.
4. **Create your admin account.** Use your own email and name. It asks you to type a password (at least 10 characters).
   ```bash
   npm run create-admin -- colin@madaketbrands.com "Colin Crowley"
   ```
   You should see `✓ colin@madaketbrands.com is an admin`.
5. **Start the app:**
   ```bash
   npm run dev
   ```
6. **Test a generation:**
   - Open [http://localhost:3000](http://localhost:3000) and sign in.
   - Pick **Nano Banana 2 Lite**, type a prompt and click **Generate**. It costs about 2 cents.
   - An image should appear in the gallery within about 30 seconds. That confirms Kie and Supabase both work.
7. Press **Ctrl + C** in Terminal to stop the app.

`.env.local` stays on your computer. It's excluded from GitHub automatically.

---

## Part 4 — Put the code on GitHub

1. Go to [github.com/new](https://github.com/new).
   - Name the repository `madaket-gen-studio` and set it to **Private**.
   - Don't add a README, .gitignore or license.
   - Click **Create repository**.
2. In Terminal, run the command below. Replace `YOUR-GITHUB-USERNAME` first.
   ```bash
   cd ~/Claude/madaket-gen-studio && git init -q 2>/dev/null; git add -A && git commit -m "Madaket Gen Studio" && git branch -M main && git remote add origin https://github.com/YOUR-GITHUB-USERNAME/madaket-gen-studio.git && git push -u origin main
   ```
   If GitHub asks you to sign in, follow the prompt in your browser.
3. Refresh the GitHub page. You should see the project files.

---

## Part 5 — Deploy on Vercel

1. Go to [vercel.com/new](https://vercel.com/new), connect GitHub if asked, and click **Import** next to `madaket-gen-studio`. Vercel detects that it's a Next.js app.
2. Before clicking Deploy, open **Environment Variables** and add each of these (name on the left, your saved value on the right).

   **Shortcut:** copy everything in your `.env.local` and paste it into the first **Name** box. Vercel splits it into separate variables for you. Afterwards, delete any variable with an empty value and check that no value has a `# comment` stuck on the end.

   | Name | Value |
   |---|---|
   | `KIE_API_KEY` | from 1a |
   | `GOOGLE_AI_API_KEY` | from 1b |
   | `API_SECRET_SALT` | from 1c |
   | `NEXT_PUBLIC_SUPABASE_URL` | from 2c |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | from 2c |
   | `SUPABASE_SERVICE_ROLE_KEY` | from 2c |
   | `SPEND_TIMEZONE` | `America/New_York` |

3. Click **Deploy** and wait 2–3 minutes.
4. Copy your site address from the success screen, e.g. `https://madaket-gen-studio.vercel.app`.

**Custom domain (optional).** To use something like `studio.madaketbrands.com`:
1. Add it in Vercel under **Settings → Domains**.
2. Add a `NEXT_PUBLIC_APP_URL` environment variable set to that address.
3. Redeploy from the **Deployments** tab (⋯ menu → **Redeploy**).

---

## Part 6 — Check the live site

1. Open your Vercel address and sign in with the admin account from Part 3.
2. **Test the image path.** Generate a **Nano Banana 2 Lite** image.
3. **Test video.** Generate a **Hailuo H3** video at 768P, 6 seconds, for about $0.24. Video takes 1–5 minutes.
4. **Check spend.** Open **Spend**. Both jobs should be listed.
5. **Test adding someone.** Add yourself at a second email address (see Part 7). In a private/incognito window, sign in with the temporary password. Check that you're asked to choose a new one, then land in the Studio.

If all of these work, you're live. 🎉

---

## Part 7 — Add your editors

1. Go to **Team & API** in the top nav (only admins see it).
2. Under **Add someone**, enter the editor's email and name, choose **Editor**, and click **Create account**.
3. A box shows their temporary password and a ready-to-send message. Click **Copy message** and send it privately (1Password share, iMessage or Signal). **The password is shown only once.** If you lose it, use **Reset password**.
4. They sign in, choose their own password, and land in the Studio. On the Team page, a **Temp password** tag shows who hasn't done that yet.
5. Send them **EDITOR-GUIDE.md**. It's a one-page how-to.

**Forgotten passwords:** there's no self-serve reset email. When an editor is locked out, click **Reset password** next to their name and send them the new temporary password. Anyone can change their own password any time with the 🔑 icon in the top-right corner.

**If you (the admin) are locked out,** set a new password from your Mac — it works against the live site too, because it uses the same Supabase project:
```bash
cd ~/Claude/madaket-gen-studio && npm run set-password -- colin@madaketbrands.com
```

**What editors can and can't do:**
- **Can:** generate, upload media, and see their own work plus anything teammates shared.
- **Can't:** see the Spend page, manage the team, or delete other people's work.
- **You (admin):** see everything, including generations marked private.

**Removing someone:** on **Team & API**, click **Deactivate**. They're signed out immediately. Their past generations stay, so spend history remains accurate.

---

## Day-to-day

- **Credits.** Watch your balance in the Kie dashboard.
  - If Kie runs out, jobs fail with "Kie.ai is out of credits" until you top up.
  - Temporary Kie errors are retried automatically (failed Kie jobs aren't charged). If Kie is having a bad day, a yellow notice appears above the gallery.
- **Supabase limits.** The free plan allows 1 GB of stored files and 5 GB of downloads per month; Pro ($25/month) raises that to 100 GB and 250 GB. Generated files add up fast (about 6 MB each), so check **Usage** in the Supabase dashboard now and then, and delete work you don't need.
- **Old files are deleted automatically.** Generated images and videos are removed 7 days after they're made; the gallery card, prompt and cost stay, and uploads are never touched. Change it with the Vercel variable `RETENTION_DAYS` (e.g. `30`, or `off`), and make sure `CRON_SECRET` is set or the daily cleanup can't run.
- **Spend.** The **Spend** page shows today, this week, this month, and breakdowns by model and by person.
- **Updates.** Any change pushed to GitHub (`git push`) redeploys the site automatically within about 2 minutes.
- **Changing prices or models.** Everything lives in one file, `src/config/models.config.ts`. Ask Claude to update it, run `npm test`, then push.

---

## Using it from Claude (MCP)

This lets Claude Code generate images and videos in Gen Studio for you, e.g. "make starting frames for all 12 scenes". Everything it makes lands in the gallery and on the Spend page.

1. On the live site, open **Team & API**. Under **API keys**, pick who the key belongs to (tip: first create a "Claude" identity under **Add an API identity**, so its work shows under its own name in the gallery), give the key a label like `Claude Code`, and click create. Copy the `mgs_…` key; it's shown once.
2. In Terminal, run this, pasting your key in place of `mgs_…`:
   ```bash
   claude mcp add --transport http --scope user madaket https://madaket-gen-studio.vercel.app/api/mcp --header "Authorization: Bearer mgs_…"
   ```
3. Start a new Claude Code session and ask for something, e.g. "Use madaket to make a 9:16 Nano Banana Pro image of…". Run `/mcp` inside Claude Code to check it's connected.

**Budget.** Each API key can spend at most **$500 per 24 hours** (failed jobs don't count). It's there to stop a runaway agent, not your own work — one call can cost up to $68. To change it, add the Vercel variable `API_DAILY_SPEND_CAP_USD` (e.g. `1000`, or `off`) and redeploy. To cut Claude off, revoke its key under **Team & API**.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `npm: command not found` | Node isn't installed. Install the LTS version from nodejs.org, then reopen Terminal. |
| `Missing required environment variable: …` | That value is missing from `.env.local` (locally) or Vercel's Environment Variables (live). In Vercel, redeploy after adding it. |
| An editor can't sign in | Check they typed the email exactly as you entered it. If it still fails, click **Reset password** and send a new temporary one. |
| Someone is stuck on "Choose your own password" | That's expected on a temporary password. The new password needs at least 10 characters, typed the same in both boxes. |
| "Someone with that email already has an account" | They're already on the Team list. Use **Reset password** instead. |
| A job fails with "Kie 401" | Wrong Kie API key. |
| A job fails with "Kie 402" | Out of Kie credits. |
| A job fails with "Kie 429" | Too many requests at once. Wait a moment and retry. |
| A card says "Taking longer than usual" | Kie is busy. The job keeps its place; it fails on its own after 60 minutes. Failed jobs aren't charged. |
| A card shows a **Backup** badge | Only possible with `GOOGLE_BACKUP=on`: Kie had a problem, so Google handled that job. Hover the badge to see why. |
| Omni Flash fails only when it's running on the Google backup, with a "duration" error | Tell Claude. It's a one-line fix in `src/providers/google.ts`. |
| Anything else | In Vercel, open your project → **Logs**, find the red error, and share it with Claude. |

---

## What's in the folder

| Path | What it is |
|---|---|
| `SETUP.md` | This guide |
| `EDITOR-GUIDE.md` | One-page guide to send your editors |
| `README.md` | Technical reference (architecture, API, adding models) |
| `.env.example` | Template for your settings file |
| `supabase/migrations/` | The two database setup files for Part 2b |
| `scripts/create-admin.mjs` | Creates your admin account (Part 3) |
| `scripts/set-password.mjs` | Sets any account's password if you're locked out |
| `src/config/models.config.ts` | Every model, price and routing rule |
| `src/providers/` | The Kie and Google connections |
| `src/app/`, `src/components/` | The website itself |

---

## Later: self-serve password reset emails (optional)

If the team grows and you want "Forgot password" emails, set up custom email with Resend. It takes about 15 minutes, including DNS records on madaketbrands.com. Ask Claude to switch it back on; the app already contains the email-link handling.

import "server-only";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/** Server-side environment. Accessed lazily so `next build` works without secrets. */
export const env = {
  get supabaseUrl() {
    return required("NEXT_PUBLIC_SUPABASE_URL");
  },
  get supabaseAnonKey() {
    return required("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  },
  get supabaseServiceRoleKey() {
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },
  get googleApiKey() {
    return required("GOOGLE_AI_API_KEY");
  },
  /** ElevenLabs direct (voiceovers). Only required when an ElevenLabs model is used. */
  get elevenLabsApiKey() {
    return required("ELEVENLABS_API_KEY");
  },
  get kieApiKey() {
    return required("KIE_API_KEY");
  },
  get apiSecretSalt() {
    return required("API_SECRET_SALT");
  },
  /** Public base URL, used for invite redirects and Kie callbacks. Optional locally. */
  get appUrl(): string | undefined {
    const explicit = process.env.NEXT_PUBLIC_APP_URL;
    if (explicit) return explicit.replace(/\/$/, "");
    if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
    return undefined;
  },
  /** Rolling 24-hour spend cap per API key (MCP/scripts), in USD. Default $100; "off" disables it. */
  get apiDailySpendCapUsd(): number | null {
    const raw = process.env.API_DAILY_SPEND_CAP_USD?.trim().toLowerCase();
    if (raw === "off" || raw === "none") return null;
    const value = raw ? Number(raw) : 500;
    return Number.isFinite(value) && value >= 0 ? value : 500;
  },
  /** Days a generated file is kept before the cleanup cron deletes it. Default 7; "off" keeps everything. */
  get retentionDays(): number | null {
    const raw = process.env.RETENTION_DAYS?.trim().toLowerCase();
    if (raw === "off" || raw === "never" || raw === "0") return null;
    const value = raw ? Number(raw) : 7;
    return Number.isFinite(value) && value > 0 ? value : 7;
  },
  get cronSecret(): string | undefined {
    return process.env.CRON_SECRET || undefined;
  },
};

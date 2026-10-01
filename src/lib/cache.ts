/**
 * Cache-Control max-age (seconds) for files we put in Supabase Storage.
 * Every object gets a unique name and is never rewritten, so browsers and the CDN can keep it
 * for a year. Supabase's default is one hour, which made every gallery visit re-download
 * full-size originals and burned through the storage egress quota.
 */
export const IMMUTABLE_CACHE = "31536000";

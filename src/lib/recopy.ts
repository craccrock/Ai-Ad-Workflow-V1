import "server-only";
import { persistOutputFile } from "@/lib/storage";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Generation } from "@/lib/types";
import { errorMessage } from "@/lib/utils";

/**
 * Jobs whose output couldn't be copied at the time (Kie's temp host stalls for minutes at a stretch)
 * finish pointing at the provider's own URL. That host is slow and expires its files, so the copy is
 * retried in the background until it lands. Providers keep outputs ~14 days; after that, nothing to do.
 */

const MAX_AGE_DAYS = 13;
/** Don't sweep on every request — once every few minutes per instance is plenty. */
const SWEEP_INTERVAL_MS = 3 * 60 * 1000;
let lastSweep = 0;

export type RecopyResult = { pending: number; copied: number; failed: number };

export async function recopyProviderHosted({ limit = 5 }: { limit?: number } = {}): Promise<RecopyResult> {
  const admin = createAdminClient();
  const since = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await admin
    .from("generations")
    .select("id, user_id, result_url, result_metadata, media_type")
    .eq("status", "completed")
    .is("result_storage_path", null)
    .not("result_url", "is", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);

  const rows = (data ?? []) as Pick<Generation, "id" | "user_id" | "result_url" | "result_metadata" | "media_type">[];
  const result: RecopyResult = { pending: rows.length, copied: 0, failed: 0 };

  for (const row of rows) {
    const meta = (row.result_metadata ?? {}) as Record<string, unknown>;
    try {
      const stored = await persistOutputFile(row.user_id, row.id, {
        url: row.result_url!,
        mimeType: (meta.mime_type as string) ?? (row.media_type === "video" ? "video/mp4" : row.media_type === "audio" ? "audio/mpeg" : "image/png"),
      });
      const { provider_url_only: _dropped, ...rest } = meta;
      void _dropped;
      await admin
        .from("generations")
        .update({
          result_url: stored.url,
          result_storage_path: stored.path,
          result_metadata: { ...rest, mime_type: stored.mimeType, file_size_bytes: stored.sizeBytes, recopied_at: new Date().toISOString() },
        })
        .eq("id", row.id);
      await admin.from("media").update({ url: stored.url, storage_path: stored.path, file_size_bytes: stored.sizeBytes }).eq("generation_id", row.id);
      result.copied += 1;
    } catch (err) {
      result.failed += 1;
      console.warn(`[recopy] still can't fetch ${row.id}:`, errorMessage(err));
    }
  }
  return result;
}

/** Fire-and-forget sweep for request handlers: throttled, and never lets its own failure surface. */
export function sweepProviderHosted() {
  if (Date.now() - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = Date.now();
  void recopyProviderHosted({ limit: 3 }).catch((err) => console.warn("[recopy] sweep failed:", errorMessage(err)));
}

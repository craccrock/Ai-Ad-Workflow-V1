import "server-only";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Generation } from "@/lib/types";

/**
 * Generated files are deleted after RETENTION_DAYS (default 7) to keep Supabase storage in check.
 * Only the file goes: the generation row keeps its prompt, settings and cost, so the Spend page
 * stays accurate and anything worth keeping can be re-run. Uploaded references are never touched.
 */

type ExpiredRow = Pick<Generation, "id" | "result_storage_path" | "result_metadata" | "completed_at">;

const pathsOf = (row: ExpiredRow) => {
  const meta = (row.result_metadata ?? {}) as { additional_storage_paths?: unknown };
  const extras = Array.isArray(meta.additional_storage_paths) ? meta.additional_storage_paths.filter((p): p is string => typeof p === "string" && p.length > 0) : [];
  return [row.result_storage_path, ...extras].filter((p): p is string => Boolean(p));
};

const sizeOf = (row: ExpiredRow) => {
  const bytes = (row.result_metadata as { file_size_bytes?: unknown } | null)?.file_size_bytes;
  return typeof bytes === "number" ? bytes : 0;
};

export type PurgeResult = { retention_days: number; expired: number; files_removed: number; freed_bytes: number; errors: string[] };

export async function purgeExpiredOutputs({ limit = 300 }: { limit?: number } = {}): Promise<PurgeResult> {
  const days = env.retentionDays;
  const base: PurgeResult = { retention_days: days ?? 0, expired: 0, files_removed: 0, freed_bytes: 0, errors: [] };
  if (!days) return { ...base, errors: ["Retention is off (RETENTION_DAYS=off)"] };

  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from("generations")
    .select("id, result_storage_path, result_metadata, completed_at")
    .eq("status", "completed")
    .not("result_storage_path", "is", null)
    .lt("completed_at", cutoff)
    .order("completed_at", { ascending: true })
    .limit(limit);
  if (error) return { ...base, errors: [error.message] };

  const rows = (data ?? []) as ExpiredRow[];
  if (!rows.length) return base;

  const paths = rows.flatMap(pathsOf);
  const { error: removeError } = await admin.storage.from("generations").remove(paths);
  // A missing object shouldn't block the bookkeeping — the row still needs marking.
  if (removeError) base.errors.push(`storage: ${removeError.message}`);

  const ids = rows.map((r) => r.id);
  const { error: mediaError } = await admin.from("media").delete().in("generation_id", ids);
  if (mediaError) base.errors.push(`media: ${mediaError.message}`);

  const deletedAt = new Date().toISOString();
  for (const row of rows) {
    const { error: updateError } = await admin
      .from("generations")
      .update({
        result_url: null,
        result_storage_path: null,
        result_metadata: { ...((row.result_metadata ?? {}) as Record<string, unknown>), file_deleted_at: deletedAt, retention_days: days },
      })
      .eq("id", row.id);
    if (updateError) base.errors.push(`row ${row.id}: ${updateError.message}`);
  }

  return {
    ...base,
    expired: rows.length,
    files_removed: paths.length,
    freed_bytes: rows.reduce((sum, row) => sum + sizeOf(row), 0),
  };
}

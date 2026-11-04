import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

/** GET /api/media/folders — distinct imported B-roll folders with counts, for the library filter. */
export async function GET(request: Request) {
  return handleRoute(async () => {
    await requireActor(request);
    const { data, error } = await createAdminClient().from("media").select("folder").not("folder", "is", null);
    if (error) throw new HttpError(500, error.message);
    const counts = new Map<string, number>();
    for (const row of data ?? []) counts.set(row.folder as string, (counts.get(row.folder as string) ?? 0) + 1);
    return Response.json({ data: [...counts].map(([folder, count]) => ({ folder, count })).sort((a, b) => a.folder.localeCompare(b.folder)) });
  });
}

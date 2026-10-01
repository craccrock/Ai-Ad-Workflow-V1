import { after } from "next/server";
import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { serializeGeneration, syncGeneration, USER_SELECT } from "@/lib/generations";
import { sweepProviderHosted } from "@/lib/recopy";
import { createAdminClient } from "@/lib/supabase/admin";
import type { GenerationWithUser } from "@/lib/types";

export const maxDuration = 120;

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(24),
  model: z.string().optional(),
  media_type: z.enum(["video", "image", "audio"]).optional(),
  user_id: z.uuid().optional(),
  status: z.enum(["queued", "processing", "completed", "failed"]).optional(),
  from: z.string().optional(), // ISO date
  to: z.string().optional(),
  sort: z.enum(["newest", "oldest", "cost"]).default("newest"),
  mine: z.enum(["true", "false"]).optional(),
});

/** GET /api/generations — paginated history (the same data the gallery shows). */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) throw new HttpError(400, "Invalid query", parsed.error.issues);
    const q = parsed.data;

    let query = createAdminClient().from("generations").select(USER_SELECT, { count: "exact" });

    // Visibility mirrors RLS: own + shared, admins see everything.
    if (!actor.isAdmin) query = query.or(`user_id.eq.${actor.profile.id},is_shared.eq.true`);
    if (q.mine === "true") query = query.eq("user_id", actor.profile.id);
    if (q.model) query = query.eq("model", q.model);
    if (q.media_type) query = query.eq("media_type", q.media_type);
    if (q.user_id) query = query.eq("user_id", q.user_id);
    if (q.status) query = query.eq("status", q.status);
    if (q.from) query = query.gte("created_at", new Date(q.from).toISOString());
    if (q.to) {
      const end = new Date(q.to);
      if (/^\d{4}-\d{2}-\d{2}$/.test(q.to)) end.setUTCDate(end.getUTCDate() + 1); // inclusive whole day
      query = query.lt("created_at", end.toISOString());
    }

    query =
      q.sort === "cost"
        ? query.order("cost_usd", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false })
        : query.order("created_at", { ascending: q.sort === "oldest" });

    const offset = (q.page - 1) * q.limit;
    const { data, count, error } = await query.range(offset, offset + q.limit - 1);
    if (error) throw new HttpError(500, error.message);

    // Keep API consumers fresh without separate polling: sync in-flight rows on this page.
    const rows = await Promise.all(
      (data as GenerationWithUser[]).map(async (row) =>
        row.status === "queued" || row.status === "processing" ? { ...(await syncGeneration(row)), user: row.user } : row,
      ),
    );

    // Retry any output that never made it into our storage, while someone is using the app.
    after(sweepProviderHosted);

    return Response.json({
      data: rows.map(serializeGeneration),
      page: q.page,
      limit: q.limit,
      total: count ?? 0,
      has_more: offset + rows.length < (count ?? 0),
    });
  });
}

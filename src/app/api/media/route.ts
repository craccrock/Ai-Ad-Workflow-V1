import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { importMediaFromUrl } from "@/lib/media";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 120;

const listSchema = z.object({
  type: z.enum(["image", "video", "audio"]).optional(),
  source: z.enum(["uploads", "generated"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(48),
});

/** GET /api/media — shared team library (uploads + generated outputs). */
export async function GET(request: Request) {
  return handleRoute(async () => {
    await requireActor(request);
    const parsed = listSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) throw new HttpError(400, "Invalid query", parsed.error.issues);
    const q = parsed.data;

    let query = createAdminClient()
      .from("media")
      .select("*, user:profiles(id, display_name, avatar_url, is_bot)", { count: "exact" })
      .order("created_at", { ascending: false });
    if (q.type) query = query.eq("type", q.type);
    if (q.source === "uploads") query = query.is("generation_id", null);
    if (q.source === "generated") query = query.not("generation_id", "is", null);

    const offset = (q.page - 1) * q.limit;
    const { data, count, error } = await query.range(offset, offset + q.limit - 1);
    if (error) throw new HttpError(500, error.message);
    return Response.json({ data, page: q.page, limit: q.limit, total: count ?? 0, has_more: offset + (data?.length ?? 0) < (count ?? 0) });
  });
}

const metadataSchema = z
  .object({
    width: z.number().optional(),
    height: z.number().optional(),
    duration_seconds: z.number().optional(),
    mime_type: z.string().optional(),
  })
  .partial()
  .optional();

const registerSchema = z.object({
  // Browser flow: file already uploaded to the `media` bucket under `<user_id>/…`
  storage_path: z.string().min(3),
  filename: z.string().min(1).max(300),
  type: z.enum(["image", "video", "audio"]),
  file_size_bytes: z.number().int().nonnegative().optional(),
  metadata: metadataSchema,
});

const importSchema = z.object({
  // API flow: we fetch a URL and store a copy
  url: z.url(),
  filename: z.string().max(300).optional(),
  metadata: metadataSchema,
});

/**
 * POST /api/media
 *  - { storage_path, filename, type, ... } registers a browser upload
 *  - { url, filename? } imports a remote file into the library (for API clients)
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const json = await request.json().catch(() => null);
    const admin = createAdminClient();
    const userId = actor.profile.id;

    const reg = registerSchema.safeParse(json);
    if (reg.success) {
      if (!reg.data.storage_path.startsWith(`${userId}/`)) throw new HttpError(403, "storage_path must be inside your own folder");
      const { data: pub } = admin.storage.from("media").getPublicUrl(reg.data.storage_path);
      const { data, error } = await admin
        .from("media")
        .insert({ user_id: userId, ...reg.data, url: pub.publicUrl })
        .select("*")
        .single();
      if (error) throw new HttpError(500, error.message);
      return Response.json(data, { status: 201 });
    }

    const imp = importSchema.safeParse(json);
    if (!imp.success) throw new HttpError(400, "Expected { storage_path, filename, type } or { url }", imp.error.issues);

    const data = await importMediaFromUrl(actor, imp.data);
    return Response.json(data, { status: 201 });
  });
}

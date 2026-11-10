import { z } from "zod";
import { STARTER_MAX_IMAGES, STARTER_MODEL_IDS } from "@/config/starter";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { createGenerations, generateBodySchema, serializeGeneration } from "@/lib/generations";
import { listStarterTakes } from "@/lib/starter";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 300;

/** GET /api/starter — every starter take, newest first. */
export async function GET(request: Request) {
  return handleRoute(async () => {
    await requireActor(request);
    return Response.json({ takes: await listStarterTakes() });
  });
}

const bodySchema = z.object({
  prompt: z.string().trim().min(3).max(20000),
  models: z.array(z.enum(STARTER_MODEL_IDS)).min(1).max(STARTER_MODEL_IDS.length),
  variants: z.number().int().min(1).max(4).default(1),
  aspect_ratio: z.string().default("9:16"),
  resolution: z.string().optional(),
  image_urls: z.array(z.url()).max(STARTER_MAX_IMAGES).default([]),
  direction: z.string().max(4000).optional(),
});

/**
 * POST /api/starter — runs one prompt on each ticked model (`variants` images apiece) and records the jobs as
 * starter takes. Returns at once with the queued jobs; the page polls each one.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Invalid body", parsed.error.issues);
    const b = parsed.data;
    const admin = createAdminClient();
    const takes = [];
    const errors: string[] = [];
    for (const model of new Set(b.models)) {
      const params: Record<string, unknown> = { prompt: b.prompt, aspect_ratio: b.aspect_ratio };
      if (b.image_urls.length) params.image_urls = b.image_urls;
      if (b.resolution) params.resolution = b.resolution;
      try {
        const { rows } = await createGenerations(actor, generateBodySchema.parse({ model, params, variants: b.variants }));
        const { error } = await admin.from("starter_takes").insert(rows.map((r) => ({ generation_id: r.id, user_id: actor.profile.id, direction: b.direction ?? null })));
        if (error) throw new HttpError(500, error.message);
        for (const r of rows) takes.push({ ...serializeGeneration(r), favorite: false, direction: b.direction ?? null });
      } catch (e) {
        // One model refusing (bad resolution, spend cap) shouldn't lose the others.
        const details = e instanceof HttpError && Array.isArray(e.details) ? `: ${(e.details as unknown[]).join("; ")}` : "";
        errors.push(`${model}: ${e instanceof Error ? e.message : String(e)}${details}`);
      }
    }
    if (!takes.length) throw new HttpError(422, errors.join(" | ") || "Nothing was generated");
    return Response.json({ takes, errors }, { status: 202 });
  });
}

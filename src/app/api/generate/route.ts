import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { createGenerations, generateBodySchema, serializeGeneration } from "@/lib/generations";

// Provider calls run in after(). 300s is the max on every Vercel plan (Pro can raise to 800).
export const maxDuration = 300;

/**
 * POST /api/generate
 * Authorization: Bearer <API_KEY>  (or a signed-in browser session)
 * { "model": "<id or provider endpoint>", "params": {...}, "variants": 1, "dry_run": false }
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const json = await request.json().catch(() => {
      throw new HttpError(400, "Body must be JSON");
    });
    const parsed = generateBodySchema.safeParse(json);
    if (!parsed.success) throw new HttpError(400, "Invalid request body", parsed.error.issues);

    const { model, params, mode, estimate, rows } = await createGenerations(actor, parsed.data);

    if (parsed.data.dry_run) {
      return Response.json({ dry_run: true, model: model.id, mode, params, estimate });
    }

    return Response.json(
      {
        job_id: rows[0].id,
        job_ids: rows.map((r) => r.id),
        batch_id: rows[0].batch_id,
        status: "queued",
        model: model.id,
        estimated_cost_usd: estimate.total,
        jobs: rows.map(serializeGeneration),
      },
      { status: 202 },
    );
  });
}

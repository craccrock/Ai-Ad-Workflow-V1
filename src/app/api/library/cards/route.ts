import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { cardStatus, describePending } from "@/lib/library-cards";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 300;

const bodySchema = z.object({
  /** How many images to describe in this call; the client loops until none remain. */
  limit: z.number().int().min(1).max(16).default(8),
  /** Clear every existing card first, so the whole library is described again. Admin only. */
  redo: z.boolean().default(false),
});

/** GET /api/library/cards — how many library images have a vision card. */
export async function GET(request: Request) {
  return handleRoute(async () => {
    await requireActor(request);
    return Response.json(await cardStatus());
  });
}

/** POST /api/library/cards — has Claude look at the next few undescribed library images and write their cards. */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, "Invalid body", parsed.error.issues);
    if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, "ANTHROPIC_API_KEY is not set");
    if (parsed.data.redo) {
      if (!actor.isAdmin) throw new HttpError(403, "Only an admin can redo every card");
      await createAdminClient().from("media").update({ card: null }).not("folder", "is", null).eq("type", "image");
    }
    const result = await describePending(parsed.data.limit);
    return Response.json({ ...result, ...(await cardStatus()) });
  });
}

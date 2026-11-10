import { z } from "zod";
import { STARTER_MAX_IMAGES } from "@/config/starter";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { writeStarterPrompt } from "@/lib/starter";

export const maxDuration = 120;

const bodySchema = z.object({
  direction: z.string().trim().min(1).max(4000),
  images: z.array(z.object({ url: z.url(), send: z.boolean() })).max(STARTER_MAX_IMAGES).default([]),
  current_prompt: z.string().max(20000).optional(),
});

/** POST /api/starter/prompt — Claude writes a starter-image prompt from a direction and the attached images. */
export async function POST(request: Request) {
  return handleRoute(async () => {
    await requireActor(request);
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Invalid body", parsed.error.issues);
    const out = await writeStarterPrompt({ direction: parsed.data.direction, images: parsed.data.images, currentPrompt: parsed.data.current_prompt });
    return Response.json(out);
  });
}

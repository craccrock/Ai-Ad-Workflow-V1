import { z } from "zod";
import { DEFAULT_AVATAR_PROMPT } from "@/config/board-avatar-prompt";
import { DEFAULT_BRAIN_PROMPT } from "@/config/board-brain-prompt";
import { DEFAULT_VIDEO_PROMPT } from "@/config/board-video-prompt";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { DEFAULT_SETTINGS, getSettings, setSettings } from "@/lib/settings";

/** GET /api/settings — the board tunables (the brain prompt is admin-only). */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const settings = await getSettings();
    if (!actor.isAdmin) return Response.json({ board_concurrency: settings.board_concurrency, board_default_model: settings.board_default_model });
    return Response.json({ ...settings, defaults: { ...DEFAULT_SETTINGS, board_brain_prompt: DEFAULT_BRAIN_PROMPT, board_video_prompt: DEFAULT_VIDEO_PROMPT, board_avatar_prompt: DEFAULT_AVATAR_PROMPT } });
  });
}

const schema = z.object({
  board_brain_prompt: z.string().min(50).max(60000).optional(),
  board_brain_model: z.string().min(3).max(80).optional(),
  board_concurrency: z.number().int().min(1).max(8).optional(),
  board_default_model: z.string().min(1).max(80).optional(),
  board_video_prompt: z.string().min(50).max(60000).optional(),
  board_default_video_model: z.string().min(1).max(80).optional(),
  board_avatar_prompt: z.string().min(50).max(60000).optional(),
  board_default_avatar_model: z.string().min(1).max(80).optional(),
});

/** PUT /api/settings — admin only. */
export async function PUT(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor(request, { admin: true });
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Invalid settings", parsed.error.issues);
    await setSettings(parsed.data, actor.profile.id);
    return Response.json(await getSettings());
  });
}

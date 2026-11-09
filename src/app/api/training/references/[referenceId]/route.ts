import { z } from "zod";
import { handleRoute, HttpError, requireActor } from "@/lib/auth";
import { analyzeReference, referenceGuideParagraph } from "@/lib/reference-edits";
import { getSettings, setSettings } from "@/lib/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ReferenceEdit } from "@/lib/types";

export const maxDuration = 300;

async function load(referenceId: string): Promise<ReferenceEdit> {
  const { data } = await createAdminClient().from("reference_edits").select("*").eq("id", referenceId).maybeSingle();
  if (!data) throw new HttpError(404, "Reference not found");
  return data as ReferenceEdit;
}

const actionSchema = z.object({ action: z.enum(["apply", "reanalyze"]), title: z.string().trim().min(1).max(200).optional() });

/**
 * POST /api/training/references/:id
 *  - { action: "apply" }      admin: sets the cutter's pacing knobs from this reference and adds its paragraph to the style guide
 *  - { action: "reanalyze" }  runs the analysis again (after a failure, or with a better model)
 */
export async function POST(request: Request, ctx: RouteContext<"/api/training/references/[referenceId]">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { referenceId } = await ctx.params;
    const parsed = actionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Invalid body", parsed.error.issues);
    const ref = await load(referenceId);

    if (parsed.data.action === "reanalyze") {
      await createAdminClient().from("reference_edits").update({ status: "pending", error: null }).eq("id", ref.id);
      return Response.json({ reference: await analyzeReference({ ...ref, status: "pending" }) });
    }

    if (!actor.isAdmin) throw new HttpError(403, "Only an admin can change the cut rules");
    if (!ref.profile) throw new HttpError(422, "This reference hasn't been analysed yet");
    const p = ref.profile;
    const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
    const half = (n: number) => Math.round(n * 2) / 2;
    const settings = await getSettings();
    const paragraph = referenceGuideParagraph(ref);
    const marker = `Reference "${ref.title}":`;
    const guide = settings.edit_rules
      .split(/\n{2,}/)
      .filter((para) => !para.startsWith(marker))
      .concat(paragraph)
      .join("\n\n");
    const patch = {
      cut_min_broll_s: clamp(half(p.broll_runs.min || 2), 0.5, 10),
      cut_min_return_s: clamp(half(p.speaker_returns.count ? p.speaker_returns.min : settings.cut_min_return_s), 0.5, 10),
      edit_rules: guide,
    };
    await setSettings(patch, actor.profile.id);
    return Response.json({ applied: patch });
  });
}

/** DELETE /api/training/references/:id — removes the reference (the uploaded file stays in the library). */
export async function DELETE(request: Request, ctx: RouteContext<"/api/training/references/[referenceId]">) {
  return handleRoute(async () => {
    const actor = await requireActor(request);
    const { referenceId } = await ctx.params;
    const ref = await load(referenceId);
    if (!actor.isAdmin && ref.user_id !== actor.profile.id) throw new HttpError(403, "Not yours to delete");
    const { error } = await createAdminClient().from("reference_edits").delete().eq("id", ref.id);
    if (error) throw new HttpError(500, error.message);
    return Response.json({ ok: true });
  });
}

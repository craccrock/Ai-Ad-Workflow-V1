import { handleRoute, requireActor } from "@/lib/auth";
import { modelCatalog } from "@/lib/model-catalog";

/** GET /api/models — the model catalog for API clients (Claude). Mirrors models.config.ts. */
export async function GET(request: Request) {
  return handleRoute(async () => {
    await requireActor(request);
    return Response.json(modelCatalog());
  });
}

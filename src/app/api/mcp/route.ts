import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { getActor } from "@/lib/auth";
import { registerMcpTools } from "@/lib/mcp-tools";

// wait_for_generations can hold a request for up to 240s.
export const maxDuration = 300;

const handler = createMcpHandler(registerMcpTools, {
  serverInfo: { name: "madaket-gen-studio", version: "1.0.0" },
  instructions:
    "Madaket Gen Studio: the Madaket team's image and video generator. Call list_models first, estimate_cost before expensive jobs, then generate and wait_for_generations. Results land in the shared gallery. Each API key has a 24-hour spend cap (get_budget).",
});

/**
 * POST /api/mcp — MCP (Streamable HTTP). Authenticate with the same API keys as the REST API:
 * `Authorization: Bearer mgs_…` (create one under Admin → API keys). Tools run as the key's owner.
 */
const authed = withMcpAuth(
  handler,
  async (request, token) => {
    if (!token) return undefined;
    const actor = await getActor(request);
    if (!actor || actor.via !== "api_key") return undefined;
    return { token, clientId: actor.apiKeyId ?? actor.profile.id, scopes: [], extra: { actor } };
  },
  { required: true },
);

export { authed as GET, authed as POST, authed as DELETE };

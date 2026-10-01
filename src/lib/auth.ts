import "server-only";
import { redirect } from "next/navigation";
import { hashApiKey, looksLikeApiKey } from "@/lib/api-keys";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types";

export type Actor = {
  profile: Profile;
  isAdmin: boolean;
  via: "session" | "api_key";
  apiKeyId: string | null;
};

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function loadProfile(userId: string): Promise<Profile | null> {
  const { data } = await createAdminClient().from("profiles").select("*").eq("id", userId).maybeSingle();
  return (data as Profile | null) ?? null;
}

/** Resolve the caller of an API route: `Authorization: Bearer mgs_…` first, then the cookie session. */
export async function getActor(request: Request): Promise<Actor | null> {
  const header = request.headers.get("authorization");
  const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  if (bearer) {
    if (!looksLikeApiKey(bearer)) return null;
    const admin = createAdminClient();
    const { data: key } = await admin
      .from("api_keys")
      .select("id, user_id, revoked_at")
      .eq("key_hash", hashApiKey(bearer))
      .maybeSingle();
    if (!key || key.revoked_at) return null;
    const profile = await loadProfile(key.user_id);
    if (!profile) return null;
    // Fire-and-forget usage stamp.
    void admin.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", key.id).then(() => {});
    return { profile, isAdmin: profile.role === "admin", via: "api_key", apiKeyId: key.id };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const profile = await loadProfile(user.id);
  if (!profile) return null;
  return { profile, isAdmin: profile.role === "admin", via: "session", apiKeyId: null };
}

export async function requireActor(request: Request, opts: { admin?: boolean } = {}): Promise<Actor> {
  const actor = await getActor(request);
  if (!actor) throw new HttpError(401, "Unauthorized — sign in or pass `Authorization: Bearer <API_KEY>`");
  if (opts.admin && !actor.isAdmin) throw new HttpError(403, "Admin access required");
  return actor;
}

/** For Server Components / Server Actions. Redirects to /login when signed out. */
export async function requireSessionProfile(opts: { admin?: boolean } = {}): Promise<Profile> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  // Accounts created or reset by an admin carry a temporary password until the user picks their own.
  // app_metadata is only writable with the service role, so users can't clear this themselves.
  if (user.app_metadata?.must_change_password) redirect("/set-password");
  const profile = await loadProfile(user.id);
  if (!profile) redirect("/login?error=no_profile");
  if (opts.admin && profile.role !== "admin") redirect("/");
  return profile;
}

/** Wrap a route handler body so HttpErrors become JSON responses. */
export async function handleRoute(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) {
      return Response.json({ error: err.message, details: err.details }, { status: err.status });
    }
    console.error("[api] unhandled error", err);
    return Response.json({ error: err instanceof Error ? err.message : "Internal error" }, { status: 500 });
  }
}

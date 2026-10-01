"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { generateApiKey } from "@/lib/api-keys";
import { requireSessionProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateTempPassword } from "@/lib/temp-password";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const roleSchema = z.enum(["admin", "editor"]);

/** Creates an account with a temporary password (no email service needed). The password is returned once. */
export async function addUser(input: { email: string; displayName: string; role: string }): Promise<Result<{ email: string; password: string }>> {
  await requireSessionProfile({ admin: true });
  const parsed = z.object({ email: z.email(), displayName: z.string().trim().min(1).max(80), role: roleSchema }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter a valid email, name and role." };

  const admin = createAdminClient();
  const password = generateTempPassword();
  const email = parsed.data.email.trim().toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: parsed.data.displayName },
    app_metadata: { must_change_password: true },
  });
  if (error || !data.user) {
    const message = error?.message ?? "Could not create the account";
    return { ok: false, error: /already/i.test(message) ? "Someone with that email already has an account. Use Reset password instead." : message };
  }

  // The trigger creates the profile as editor; promote server-side if needed.
  if (parsed.data.role === "admin") {
    await admin.from("profiles").update({ role: "admin" }).eq("id", data.user.id);
  }
  revalidatePath("/admin/team");
  return { ok: true, email, password };
}

/** Issues a new temporary password; the user must choose their own at next sign-in. */
export async function resetUserPassword(userId: string): Promise<Result<{ email: string; password: string }>> {
  const me = await requireSessionProfile({ admin: true });
  if (userId === me.id) return { ok: false, error: "Use Change password for your own account." };
  const admin = createAdminClient();
  const { data: profile } = await admin.from("profiles").select("email, is_bot").eq("id", userId).maybeSingle();
  if (!profile) return { ok: false, error: "User not found" };
  if (profile.is_bot) return { ok: false, error: "API identities don't sign in with a password." };

  const password = generateTempPassword();
  const { error } = await admin.auth.admin.updateUserById(userId, { password, app_metadata: { must_change_password: true } });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/team");
  return { ok: true, email: profile.email, password };
}

export async function updateRole(userId: string, role: string): Promise<Result> {
  const me = await requireSessionProfile({ admin: true });
  const parsed = roleSchema.safeParse(role);
  if (!parsed.success) return { ok: false, error: "Invalid role" };
  if (userId === me.id && parsed.data !== "admin") return { ok: false, error: "You can't demote yourself." };
  const { error } = await createAdminClient().from("profiles").update({ role: parsed.data }).eq("id", userId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/team");
  return { ok: true };
}

export async function setUserActive(userId: string, active: boolean): Promise<Result> {
  const me = await requireSessionProfile({ admin: true });
  if (userId === me.id) return { ok: false, error: "You can't deactivate yourself." };
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: active ? "none" : "876000h" });
  if (error) return { ok: false, error: error.message };
  if (!active) await admin.from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("user_id", userId).is("revoked_at", null);
  revalidatePath("/admin/team");
  return { ok: true };
}

/** Service identity (e.g. "Claude") that can only authenticate with API keys. */
export async function createBotUser(displayName: string): Promise<Result> {
  await requireSessionProfile({ admin: true });
  const name = displayName.trim();
  if (!name) return { ok: false, error: "Name required" };
  const admin = createAdminClient();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bot";
  const { data, error } = await admin.auth.admin.createUser({
    email: `${slug}-${crypto.randomUUID().slice(0, 8)}@bots.madaket.internal`,
    email_confirm: true,
    password: crypto.randomUUID() + crypto.randomUUID(), // never shared; bots log in with API keys only
    user_metadata: { display_name: name },
  });
  if (error || !data.user) return { ok: false, error: error?.message ?? "Could not create user" };
  await admin.from("profiles").update({ is_bot: true }).eq("id", data.user.id);
  revalidatePath("/admin/team");
  return { ok: true };
}

export async function createApiKey(userId: string, label: string): Promise<Result<{ key: string }>> {
  await requireSessionProfile({ admin: true });
  if (!label.trim()) return { ok: false, error: "Label required" };
  const { key, hash, prefix } = generateApiKey();
  const { error } = await createAdminClient().from("api_keys").insert({ user_id: userId, key_hash: hash, key_prefix: prefix, label: label.trim() });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/team");
  return { ok: true, key };
}

export async function revokeApiKey(id: string): Promise<Result> {
  await requireSessionProfile({ admin: true });
  const { error } = await createAdminClient().from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/admin/team");
  return { ok: true };
}

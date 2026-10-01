"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function changePassword(password: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return { ok: false, error: "Your session expired. Sign in again." };
  if (typeof password !== "string" || password.length < 10) return { ok: false, error: "Use at least 10 characters." };
  if (password.length > 72) return { ok: false, error: "Use 72 characters or fewer." };

  // Service role so the temporary-password flag (app_metadata) can be cleared in the same step.
  const { error } = await createAdminClient().auth.admin.updateUserById(user.id, {
    password,
    app_metadata: { must_change_password: false },
  });
  if (error) return { ok: false, error: error.message };

  // Supabase revokes the user's sessions when the password changes, which would leave this
  // browser holding a dead token. Sign straight back in so the new session cookies replace it.
  const { error: signInError } = await supabase.auth.signInWithPassword({ email: user.email, password });
  if (signInError) return { ok: false, error: "Password saved — please sign in again with your new password." };
  return { ok: true };
}

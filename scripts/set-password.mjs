#!/usr/bin/env node
/**
 * Set (or reset) any account's password from your computer — the way back in if an
 * admin is locked out, since there's no password-reset email.
 *   npm run set-password -- colin@madaketbrands.com
 */
import { createClient } from "@supabase/supabase-js";
import { createInterface } from "node:readline/promises";

const [email] = process.argv.slice(2);
if (!email) {
  console.error("Usage: npm run set-password -- <email>");
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
const { data, error: listError } = await supabase.auth.admin.listUsers({ perPage: 1000 });
if (listError) {
  console.error(listError.message);
  process.exit(1);
}

const user = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
if (!user) {
  console.error(`No account for ${email}. Existing accounts: ${data.users.map((u) => u.email).join(", ") || "none"}`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question("New password (min 10 chars): ");
rl.close();
if (password.length < 10) {
  console.error("Password too short");
  process.exit(1);
}

// must_change_password: false — this password was chosen by the account owner, not a temporary one.
const { error } = await supabase.auth.admin.updateUserById(user.id, { password, app_metadata: { must_change_password: false } });
if (error) {
  console.error(error.message);
  process.exit(1);
}
console.log(`✓ Password updated for ${email}`);

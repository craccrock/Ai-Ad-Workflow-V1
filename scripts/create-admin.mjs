#!/usr/bin/env node
/**
 * Bootstrap the first admin (public sign-ups are disabled, so someone has to exist first).
 *   npm run create-admin -- colin@madaketbrands.com "Colin Crowley"
 * Prompts for a password. Re-running for an existing email just promotes that user to admin.
 */
import { createClient } from "@supabase/supabase-js";
import { createInterface } from "node:readline/promises";

const [email, displayName = email?.split("@")[0]] = process.argv.slice(2);
if (!email) {
  console.error('Usage: npm run create-admin -- <email> "<Display Name>"');
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

const { data: existing } = await supabase.from("profiles").select("id").eq("email", email).maybeSingle();
let userId = existing?.id;

if (!userId) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const password = await rl.question("Password (min 10 chars): ");
  rl.close();
  if (password.length < 10) {
    console.error("Password too short");
    process.exit(1);
  }
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: displayName } });
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  userId = data.user.id;
}

const { error } = await supabase.from("profiles").update({ role: "admin", display_name: displayName }).eq("id", userId);
if (error) {
  console.error(error.message);
  process.exit(1);
}
console.log(`✓ ${email} is an admin`);

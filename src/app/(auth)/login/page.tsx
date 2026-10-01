import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" && sp.next.startsWith("/") ? sp.next : "/";
  const error = typeof sp.error === "string" ? sp.error : undefined;

  // Already signed in with a session Supabase still recognizes → skip the form.
  // (Skipped when an error is shown, so a signed-in user without a profile doesn't bounce.)
  if (!error) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) redirect(next);
  }

  return <LoginForm next={next} initialError={error} />;
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { changePassword } from "./actions";

export function SetPasswordForm({ forced }: { forced: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 10) return setError("Use at least 10 characters.");
    if (password !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    setError("");
    const result = await changePassword(password);
    setBusy(false);
    if (!result.ok) return setError(result.error);
    toast.success("Password saved");
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="space-y-5">
    <form onSubmit={submit} className="space-y-5">
      <p className="text-center text-sm text-cream-2">
        {forced ? "Welcome! Choose your own password to replace the temporary one." : "Choose a new password."}
      </p>
      <div className="space-y-2">
        <Label htmlFor="pw">New password</Label>
        <Input id="pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="pw2">Confirm password</Label>
        <Input id="pw2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button type="submit" variant="gold" size="lg" className="w-full" disabled={busy}>
        {busy ? "Saving…" : "Save password"}
      </Button>
    </form>
      <div className="text-center">
        {forced ? (
          <form action="/auth/signout" method="post" className="contents">
            <button className="border-b border-cream/30 pb-0.5 text-xs text-cream-2 hover:border-cream hover:text-cream">Sign out</button>
          </form>
        ) : (
          <Link href="/" className="border-b border-cream/30 pb-0.5 text-xs text-cream-2 hover:border-cream hover:text-cream">
            Back to the studio
          </Link>
        )}
      </div>
    </div>
  );
}

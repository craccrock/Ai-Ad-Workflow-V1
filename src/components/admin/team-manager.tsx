"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { Bot, Check, Copy, KeyRound, RotateCcw, UserPlus } from "lucide-react";
import { useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";
import { addUser, createApiKey, createBotUser, resetUserPassword, revokeApiKey, setUserActive, updateRole } from "@/app/(studio)/admin/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { Badge, Card, UserAvatar } from "@/components/ui/misc";
import type { Profile } from "@/lib/types";

export type TeamMember = Profile & { last_sign_in_at: string | null; temp_password: boolean; deactivated: boolean };
export type ApiKeyRow = { id: string; user_id: string; key_prefix: string; label: string; last_used_at: string | null; revoked_at: string | null; created_at: string };

const ago = (d: string | null) => (d ? formatDistanceToNowStrict(new Date(d), { addSuffix: true }) : "never");

export function TeamManager({ me, members, apiKeys }: { me: Profile; members: TeamMember[]; apiKeys: ApiKeyRow[] }) {
  const [pending, startTransition] = useTransition();
  const [newMember, setNewMember] = useState({ email: "", displayName: "", role: "editor" });
  const [credentials, setCredentials] = useState<{ name: string; email: string; password: string; isReset: boolean } | null>(null);
  const [copiedCreds, setCopiedCreds] = useState(false);
  const [botName, setBotName] = useState("Claude");
  const [keyForm, setKeyForm] = useState({ userId: members.find((m) => m.is_bot)?.id ?? me.id, label: "" });
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const nameOf = (id: string) => members.find((m) => m.id === id)?.display_name ?? "Unknown";

  function run<T extends { ok: boolean; error?: string }>(fn: () => Promise<T>, success: string, after?: (r: T) => void) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error ?? "Something went wrong");
      toast.success(success);
      after?.(r);
    });
  }

  return (
    <div className="space-y-10">
      {/* ── Members ── */}
      <section>
        <h2 className="mb-4 font-serif text-2xl text-cream">Team</h2>
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-[11px] uppercase tracking-[0.08em] text-muted">
                <th className="px-4 py-3 font-medium">Member</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Last sign-in</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-b border-hairline last:border-0">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <UserAvatar name={m.display_name} url={m.avatar_url} bot={m.is_bot} size={28} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-cream">
                          {m.display_name}
                          {m.is_bot ? <Badge tone="gold">API bot</Badge> : null}
                          {m.temp_password ? <Badge title="Still on a temporary password. They'll choose their own at next sign-in.">Temp password</Badge> : null}
                          {m.deactivated ? <Badge tone="danger">Deactivated</Badge> : null}
                        </div>
                        {!m.is_bot ? <div className="truncate text-xs text-muted">{m.email}</div> : null}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <NativeSelect
                      aria-label={`Role for ${m.display_name}`}
                      value={m.role}
                      disabled={pending || m.id === me.id}
                      onChange={(e) => run(() => updateRole(m.id, e.target.value), "Role updated")}
                      className="h-8 w-28 text-xs"
                    >
                      <option value="editor">Editor</option>
                      <option value="admin">Admin</option>
                    </NativeSelect>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-cream-2" suppressHydrationWarning>
                    {m.is_bot ? "API only" : ago(m.last_sign_in_at)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    {m.id !== me.id && !m.is_bot && !m.deactivated ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          if (window.confirm(`Give ${m.display_name} a new temporary password? Their current password stops working.`)) {
                            run(() => resetUserPassword(m.id), "New temporary password created", (r) =>
                              setCredentials({ name: m.display_name, email: (r as { email: string }).email, password: (r as { password: string }).password, isReset: true }),
                            );
                          }
                        }}
                      >
                        <RotateCcw /> Reset password
                      </Button>
                    ) : null}
                    {m.id !== me.id ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          if (m.deactivated || window.confirm(`Deactivate ${m.display_name}? They'll be signed out and their API keys revoked. Their generations stay.`)) {
                            run(() => setUserActive(m.id, m.deactivated), m.deactivated ? "Reactivated" : "Deactivated");
                          }
                        }}
                      >
                        {m.deactivated ? "Reactivate" : "Deactivate"}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card className="p-5">
            <h3 className="mb-1 flex items-center gap-2 font-serif text-lg text-cream">
              <UserPlus className="size-4 text-gold" /> Add someone
            </h3>
            <p className="mb-4 text-xs text-cream-2">Creates their account with a temporary password for you to send them privately. They choose their own at first sign-in.</p>
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                const name = newMember.displayName;
                run(() => addUser(newMember), `${name} added`, (r) => {
                  setCredentials({ name, email: (r as { email: string }).email, password: (r as { password: string }).password, isReset: false });
                  setNewMember({ email: "", displayName: "", role: "editor" });
                });
              }}
            >
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="new-email">Email</Label>
                <Input id="new-email" type="email" required value={newMember.email} onChange={(e) => setNewMember({ ...newMember, email: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-name">Display name</Label>
                <Input id="new-name" required value={newMember.displayName} onChange={(e) => setNewMember({ ...newMember, displayName: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-role">Role</Label>
                <NativeSelect id="new-role" value={newMember.role} onChange={(e) => setNewMember({ ...newMember, role: e.target.value })}>
                  <option value="editor">Editor</option>
                  <option value="admin">Admin</option>
                </NativeSelect>
              </div>
              <Button type="submit" variant="gold" disabled={pending} className="sm:col-span-2">
                Create account
              </Button>
            </form>
          </Card>

          <Card className="p-5">
            <h3 className="mb-1 flex items-center gap-2 font-serif text-lg text-cream">
              <Bot className="size-4 text-gold" /> Add an API identity
            </h3>
            <p className="mb-4 text-xs text-cream-2">A non-login user for Claude or scripts, so their generations show under their own name in the gallery.</p>
            <form
              className="flex gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                run(() => createBotUser(botName), `${botName} created`);
              }}
            >
              <Input aria-label="Bot name" value={botName} onChange={(e) => setBotName(e.target.value)} />
              <Button type="submit" variant="outline" disabled={pending}>
                Create
              </Button>
            </form>
          </Card>
        </div>
      </section>

      {/* ── API keys ── */}
      <section>
        <h2 className="mb-1 font-serif text-2xl text-cream">API keys</h2>
        <p className="mb-4 text-sm text-cream-2">
          Use as <code className="font-mono text-xs text-gold">Authorization: Bearer mgs_…</code> for the REST API or the MCP server at <code className="font-mono text-xs">/api/mcp</code>. Each key can spend up to its 24-hour cap. Keys are stored hashed and shown once.
        </p>

        <Card className="mb-6 p-5">
          <form
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => createApiKey(keyForm.userId, keyForm.label), "API key created", (r) => {
                setNewKey((r as { key?: string }).key ?? null);
                setKeyForm((f) => ({ ...f, label: "" }));
              });
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="key-user">Acts as</Label>
              <NativeSelect id="key-user" value={keyForm.userId} onChange={(e) => setKeyForm({ ...keyForm, userId: e.target.value })}>
                {members
                  .filter((m) => !m.deactivated)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.display_name}
                      {m.is_bot ? " (bot)" : ""}
                    </option>
                  ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="key-label">Label</Label>
              <Input id="key-label" required placeholder="Claude desktop MCP" value={keyForm.label} onChange={(e) => setKeyForm({ ...keyForm, label: e.target.value })} />
            </div>
            <Button type="submit" variant="gold" disabled={pending}>
              <KeyRound /> Create key
            </Button>
          </form>
        </Card>

        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-[11px] uppercase tracking-[0.08em] text-muted">
                <th className="px-4 py-3 font-medium">Label</th>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Key</th>
                <th className="px-4 py-3 font-medium">Last used</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {apiKeys.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted">
                    No keys yet.
                  </td>
                </tr>
              ) : (
                apiKeys.map((k) => (
                  <tr key={k.id} className="border-b border-hairline last:border-0">
                    <td className="px-4 py-3 text-cream">{k.label}</td>
                    <td className="px-4 py-3 text-cream-2">{nameOf(k.user_id)}</td>
                    <td className="px-4 py-3 font-mono text-xs text-cream-2">{k.key_prefix}…</td>
                    <td className="px-4 py-3 font-mono text-xs text-cream-2">{ago(k.last_used_at)}</td>
                    <td className="px-4 py-3 text-right">
                      {k.revoked_at ? (
                        <Badge tone="danger">Revoked</Badge>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() => window.confirm(`Revoke "${k.label}"? Anything using it stops working immediately.`) && run(() => revokeApiKey(k.id), "Key revoked")}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Card>
      </section>

      <Dialog
        open={Boolean(credentials)}
        onOpenChange={(o) => {
          if (!o) {
            setCredentials(null);
            setCopiedCreds(false);
          }
        }}
      >
        {credentials ? (
          <DialogContent
            title={credentials.isReset ? `New temporary password for ${credentials.name}` : `${credentials.name}'s login`}
            description="Send this privately (1Password, iMessage). The password is shown only once."
          >
            <CredentialsMessage credentials={credentials} copied={copiedCreds} onCopied={() => setCopiedCreds(true)} />
          </DialogContent>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(newKey)}
        onOpenChange={(o) => {
          if (!o) {
            setNewKey(null);
            setCopied(false);
          }
        }}
      >
        <DialogContent title="Your new API key" description="Copy it now — it won't be shown again.">
          <div className="flex items-center gap-2 rounded-[6px] border border-field-border bg-field p-3">
            <code className="min-w-0 flex-1 break-all font-mono text-xs text-cream">{newKey}</code>
            <Button
              variant="outline"
              size="icon"
              aria-label="Copy key"
              onClick={() => {
                void navigator.clipboard.writeText(newKey!);
                setCopied(true);
              }}
            >
              {copied ? <Check className="text-success" /> : <Copy />}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CredentialsMessage({
  credentials,
  copied,
  onCopied,
}: {
  credentials: { name: string; email: string; password: string; isReset: boolean };
  copied: boolean;
  onCopied: () => void;
}) {
  // Read the origin without a server/client mismatch.
  const siteUrl = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => "",
  );
  const message = [
    credentials.isReset ? `Hi ${credentials.name.split(" ")[0]}, here's a new temporary password for Madaket Gen Studio.` : `Hi ${credentials.name.split(" ")[0]}, here's your login for Madaket Gen Studio.`,
    "",
    `Site: ${siteUrl}`,
    `Email: ${credentials.email}`,
    `Temporary password: ${credentials.password}`,
    "",
    "You'll be asked to choose your own password when you sign in.",
  ].join("\n");

  return (
    <div className="space-y-4">
      <dl className="space-y-2 rounded-[6px] border border-field-border bg-field p-3 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Email</dt>
          <dd className="font-mono text-cream">{credentials.email}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Temporary password</dt>
          <dd className="select-all font-mono text-gold">{credentials.password}</dd>
        </div>
      </dl>
      <pre className="whitespace-pre-wrap rounded-[6px] border border-hairline p-3 font-sans text-xs text-cream-2">{message}</pre>
      <Button
        variant="gold"
        className="w-full"
        onClick={() => {
          void navigator.clipboard.writeText(message);
          onCopied();
        }}
      >
        {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy message"}
      </Button>
    </div>
  );
}

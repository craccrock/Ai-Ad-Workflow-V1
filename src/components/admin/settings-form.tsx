"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { AVATAR_MODEL_IDS } from "@/config/avatar";
import { models } from "@/config/models.config";
import { api } from "@/lib/client-api";
import type { AppSettings } from "@/lib/settings";

const BRAIN_MODELS = [
  { value: "claude-opus-5-5", label: "Claude Opus 5.5 (best)" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (faster, cheaper)" },
  { value: "claude-haiku-5-5", label: "Claude Haiku 5.5 (cheapest)" },
];

export function SettingsForm({ initial, defaultPrompt, defaultVideoPrompt, defaultAvatarPrompt, anthropicConfigured }: { initial: AppSettings; defaultPrompt: string; defaultVideoPrompt: string; defaultAvatarPrompt: string; anthropicConfigured: boolean }) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const placeholders = ["{{SUBJECT_LOCK}}", "{{LIBRARY_INDEX}}", "{{SCRIPT}}"].filter((p) => !form.board_brain_prompt.includes(p));
  const videoPlaceholders = ["{{SUBJECT_LOCK}}", "{{STYLE_LOCKS}}", "{{BEATS}}"].filter((p) => !form.board_video_prompt.includes(p));
  const avatarPlaceholders = ["{{SUBJECT_LOCK}}", "{{DURATIONS}}", "{{BEATS}}"].filter((p) => !form.board_avatar_prompt.includes(p));

  async function save() {
    setSaving(true);
    try {
      const saved = await api<AppSettings>("/api/settings", { method: "PUT", json: form });
      setForm(saved);
      toast.success("Settings saved");
      window.location.reload();
    } catch (e) {
      toast.error("Couldn't save", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-4xl space-y-6">
      {!anthropicConfigured ? (
        <p className="rounded-[6px] border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-cream">
          <strong>ANTHROPIC_API_KEY is not set.</strong> The beat splitter can&apos;t run until it is added to the environment (Vercel → Settings → Environment Variables, then redeploy).
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-4">
        <div>
          <Label className="mb-1.5">Brain model</Label>
          <NativeSelect value={form.board_brain_model} onChange={(e) => setForm({ ...form, board_brain_model: e.target.value })}>
            {BRAIN_MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div>
          <Label className="mb-1.5">Generate-all concurrency</Label>
          <Input type="number" min={1} max={20} value={form.board_concurrency} onChange={(e) => setForm({ ...form, board_concurrency: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} />
          <p className="mt-1 text-[11px] text-muted">How many images render at the same time.</p>
        </div>
        <div>
          <Label className="mb-1.5">Default image model</Label>
          <NativeSelect value={form.board_default_model} onChange={(e) => setForm({ ...form, board_default_model: e.target.value })}>
            {models
              .filter((m) => m.category === "image")
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </NativeSelect>
        </div>
        <div>
          <Label className="mb-1.5">Default video model</Label>
          <NativeSelect value={form.board_default_video_model} onChange={(e) => setForm({ ...form, board_default_video_model: e.target.value })}>
            {models
              .filter((m) => m.category === "video" && m.inputTypes.includes("image-to-video"))
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.tier ? `${m.name} ${m.tier}` : m.name}
                </option>
              ))}
          </NativeSelect>
        </div>
        <div>
          <Label className="mb-1.5">Default avatar (talking-head) model</Label>
          <NativeSelect value={form.board_default_avatar_model} onChange={(e) => setForm({ ...form, board_default_avatar_model: e.target.value })}>
            {AVATAR_MODEL_IDS.map((id) => models.find((m) => m.id === id))
              .filter((m): m is NonNullable<typeof m> => Boolean(m))
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.tier ? `${m.name} ${m.tier}` : m.name}
                </option>
              ))}
          </NativeSelect>
        </div>
      </div>

      <div>
        <Label>Standing image-prompt rules</Label>
        <p className="mb-1.5 mt-1 text-[11px] text-muted">One rule per line. Added to the splitter and to every image reprompt, and they win over the defaults. Ticking Remember on a board redo appends here.</p>
        <Textarea value={form.image_prompt_rules ?? ""} onChange={(e) => setForm({ ...form, image_prompt_rules: e.target.value })} rows={6} className="font-sans text-[12px] leading-relaxed" placeholder="No standing rules yet." />
      </div>

      <div>
        <div className="mb-1.5 flex items-end justify-between gap-3">
          <div>
            <Label>Brain system prompt</Label>
            <p className="mt-1 text-[11px] text-muted">
              Must contain <code className="font-mono">{"{{SUBJECT_LOCK}}"}</code>, <code className="font-mono">{"{{LIBRARY_INDEX}}"}</code> and <code className="font-mono">{"{{SCRIPT}}"}</code>; they&apos;re filled in on every split.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setForm({ ...form, board_brain_prompt: defaultPrompt })}>
            Reset to default
          </Button>
        </div>
        <Textarea value={form.board_brain_prompt} onChange={(e) => setForm({ ...form, board_brain_prompt: e.target.value })} rows={28} className="font-mono text-[12px] leading-relaxed" spellCheck={false} />
        {placeholders.length ? <p className="mt-1 text-xs text-danger">Missing placeholder{placeholders.length > 1 ? "s" : ""}: {placeholders.join(", ")}</p> : null}
      </div>

      <div>
        <div className="mb-1.5 flex items-end justify-between gap-3">
          <div>
            <Label>Video prompt writer</Label>
            <p className="mt-1 text-[11px] text-muted">
              Writes the image-to-video prompt for each beat. Must contain <code className="font-mono">{"{{SUBJECT_LOCK}}"}</code>, <code className="font-mono">{"{{STYLE_LOCKS}}"}</code> and <code className="font-mono">{"{{BEATS}}"}</code>.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setForm({ ...form, board_video_prompt: defaultVideoPrompt })}>
            Reset to default
          </Button>
        </div>
        <Textarea value={form.board_video_prompt} onChange={(e) => setForm({ ...form, board_video_prompt: e.target.value })} rows={20} className="font-mono text-[12px] leading-relaxed" spellCheck={false} />
        {videoPlaceholders.length ? <p className="mt-1 text-xs text-danger">Missing placeholder{videoPlaceholders.length > 1 ? "s" : ""}: {videoPlaceholders.join(", ")}</p> : null}
      </div>

      <div>
        <div className="mb-1.5 flex items-end justify-between gap-3">
          <div>
            <Label>Avatar prompt writer</Label>
            <p className="mt-1 text-[11px] text-muted">
              Writes the talking-head (A-roll) prompt for each chunk from the avatar still. Must contain <code className="font-mono">{"{{SUBJECT_LOCK}}"}</code>, <code className="font-mono">{"{{DURATIONS}}"}</code> and <code className="font-mono">{"{{BEATS}}"}</code>.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setForm({ ...form, board_avatar_prompt: defaultAvatarPrompt })}>
            Reset to default
          </Button>
        </div>
        <Textarea value={form.board_avatar_prompt} onChange={(e) => setForm({ ...form, board_avatar_prompt: e.target.value })} rows={20} className="font-mono text-[12px] leading-relaxed" spellCheck={false} />
        {avatarPlaceholders.length ? <p className="mt-1 text-xs text-danger">Missing placeholder{avatarPlaceholders.length > 1 ? "s" : ""}: {avatarPlaceholders.join(", ")}</p> : null}
      </div>

      <div>
        <Label>Pronunciation guide</Label>
        <p className="mb-1.5 mt-1 text-[11px] text-muted">
          One per line, <code className="font-mono">term = phonetic respelling</code>. The avatar writer swaps these into the spoken line (CAPITALS mark the stressed syllable) so the voice model says them right. Case-insensitive.
        </p>
        <Textarea value={form.board_pronunciations} onChange={(e) => setForm({ ...form, board_pronunciations: e.target.value })} rows={6} className="font-mono text-[12px] leading-relaxed" spellCheck={false} placeholder={"seborrheic keratosis = seb-oh-REE-ik kair-uh-TOE-sis"} />
      </div>

      <div className="flex justify-end">
        <Button variant="gold" disabled={!dirty || saving || placeholders.length > 0 || videoPlaceholders.length > 0 || avatarPlaceholders.length > 0} onClick={save}>
          {saving ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
  );
}

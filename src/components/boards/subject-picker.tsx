"use client";

import { Plus, Star } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { ImageThumb } from "@/components/ui/thumb";
import { api, type ApiMedia } from "@/lib/client-api";
import type { Subject } from "@/lib/types";
import { RefSlot } from "./ref-slot";

/** Subject Lock chooser for a board: pick a saved subject, or create one (name + base image + base prompt). */
export function SubjectPicker({ value, userId, canEdit, onChange }: { value: Subject | null; userId: string; canEdit: boolean; onChange: (s: Subject | null) => void }) {
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [basePrompt, setBasePrompt] = useState("");
  const [image, setImage] = useState<ApiMedia | null>(null);
  const [makeDefault, setMakeDefault] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ data: Subject[] }>("/api/subjects")
      .then((r) => setSubjects(r.data))
      .catch((e) => toast.error("Couldn't load subjects", { description: e.message }));
  }, []);

  async function create() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const s = await api<Subject>("/api/subjects", { method: "POST", json: { name: name.trim(), base_prompt: basePrompt, media_id: image?.id ?? null, is_default: makeDefault } });
      setSubjects((prev) => [s, ...(prev ?? []).map((p) => (makeDefault ? { ...p, is_default: false } : p))]);
      onChange(s);
      setCreating(false);
      setName("");
      setBasePrompt("");
      setImage(null);
      toast.success("Subject saved", { description: s.name });
    } catch (e) {
      toast.error("Couldn't save subject", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <Label>Subject lock</Label>
        {canEdit ? (
          <button type="button" onClick={() => setCreating(true)} className="flex items-center gap-1 text-[11px] text-cream-2 hover:text-cream">
            <Plus className="size-3.5" /> New subject
          </button>
        ) : null}
      </div>
      <NativeSelect value={value?.id ?? ""} disabled={!canEdit || !subjects} onChange={(e) => onChange(subjects?.find((s) => s.id === e.target.value) ?? null)}>
        <option value="">No subject lock</option>
        {(subjects ?? []).map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {s.is_default ? " ★" : ""}
          </option>
        ))}
      </NativeSelect>
      {value ? (
        <div className="mt-2 flex gap-3 rounded-[6px] border border-hairline bg-field p-2">
          <div className="relative h-20 w-16 shrink-0 overflow-hidden rounded bg-navy">
            {value.media?.url ? <ImageThumb src={value.media.url} alt={value.name} sizes="64px" className="object-cover" /> : <div className="flex h-full items-center justify-center text-[10px] text-muted">no image</div>}
          </div>
          <p className="line-clamp-4 text-[11px] leading-snug text-cream-2">{value.base_prompt || "No base prompt."}</p>
        </div>
      ) : (
        <p className="mt-1.5 text-[11px] text-muted">Without a lock, subject shots are generated from the prompt alone and the person will differ between beats.</p>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent title="New subject lock" description="The base image and description attach to every beat where this person appears, so she stays the same across the board.">
          <div className="grid gap-4 sm:grid-cols-[150px_1fr]">
            <RefSlot label="Base image" media={image} userId={userId} onChange={setImage} />
            <div className="space-y-3">
              <div>
                <Label className="mb-1">Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Maya, 34, SK ad" autoFocus />
              </div>
              <div>
                <Label className="mb-1">Base prompt</Label>
                <Textarea value={basePrompt} onChange={(e) => setBasePrompt(e.target.value)} rows={5} placeholder="Who she is, skin tone, hair, build, usual clothing, vibe — the brain copies this into every subject shot." className="font-sans text-[12px]" />
              </div>
              <label className="flex items-center gap-2 text-xs text-cream-2">
                <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} className="accent-gold" />
                <Star className="size-3.5" /> Use as the default for new boards
              </label>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button variant="gold" disabled={!name.trim() || saving} onClick={create}>
              {saving ? "Saving…" : "Save subject"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

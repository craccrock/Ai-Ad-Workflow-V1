"use client";

import { Loader2, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { CUT_RULE_FIELDS, type CutRules } from "@/config/edit-rules";
import { api } from "@/lib/client-api";

export type RulesPayload = CutRules & { edit_rules: string };

export async function fetchCutRules(): Promise<RulesPayload> {
  const s = await api<Record<string, unknown>>("/api/settings");
  return {
    edit_rules: String(s.edit_rules ?? ""),
    min_broll_s: Number(s.cut_min_broll_s ?? 2),
    min_return_s: Number(s.cut_min_return_s ?? 2),
    head_pad_s: Number(s.cut_head_pad_s ?? 0.12),
    tail_pad_s: Number(s.cut_tail_pad_s ?? 0.18),
  };
}

/** The cutter's shared knobs and style guide. Loads itself; admins can save. `reloadKey` forces a refetch. */
export function CutRulesEditor({ isAdmin, reloadKey = 0 }: { isAdmin: boolean; reloadKey?: number }) {
  const [rules, setRules] = useState<RulesPayload | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchCutRules()
      .then((r) => {
        if (!alive) return;
        setRules(r);
        setDirty(false);
      })
      .catch((e) => toast.error("Couldn't load the cut rules", { description: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  async function save() {
    if (!rules) return;
    setSaving(true);
    try {
      await api("/api/settings", { method: "PUT", json: { edit_rules: rules.edit_rules, cut_min_broll_s: rules.min_broll_s, cut_min_return_s: rules.min_return_s, cut_head_pad_s: rules.head_pad_s, cut_tail_pad_s: rules.tail_pad_s } });
      setDirty(false);
      toast.success("Cut rules saved", { description: "Applied on the next assemble or re-cut." });
    } catch (e) {
      toast.error("Couldn't save the rules", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  if (!rules) return <p className="text-[11px] text-muted">Loading…</p>;
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {CUT_RULE_FIELDS.map((f) => (
          <label key={f.key} className="text-[10px] uppercase tracking-[0.08em] text-muted" title={f.hint}>
            {f.label}
            <Input
              type="number"
              min={f.min}
              max={f.max}
              step={f.step}
              value={rules[f.key]}
              disabled={!isAdmin}
              onChange={(e) => {
                setRules({ ...rules, [f.key]: Number(e.target.value) });
                setDirty(true);
              }}
              className="mt-0.5 h-7 font-mono text-[11px]"
            />
          </label>
        ))}
      </div>
      <label className="block text-[10px] uppercase tracking-[0.08em] text-muted">
        Style guide (what the cutter is told)
        <Textarea
          value={rules.edit_rules}
          disabled={!isAdmin}
          rows={6}
          onChange={(e) => {
            setRules({ ...rules, edit_rules: e.target.value });
            setDirty(true);
          }}
          className="mt-0.5 text-[12px] leading-snug normal-case tracking-normal"
        />
      </label>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={!isAdmin || !dirty || saving} onClick={() => void save()}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />} Save rules
        </Button>
        <span className="text-[11px] text-muted">{isAdmin ? "Shared across all boards. Knobs apply on the next assemble; the style guide is what the editor brain reads." : "Only an admin can change these."}</span>
      </div>
    </div>
  );
}

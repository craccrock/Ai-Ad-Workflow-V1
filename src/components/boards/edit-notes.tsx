"use client";

import { ChevronDown, Loader2, MessageSquareText, Save, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { CUT_RULE_FIELDS, type CutRules } from "@/config/edit-rules";
import { api } from "@/lib/client-api";
import type { EditNote } from "@/lib/types";
import { cn } from "@/lib/utils";

type RulesPayload = CutRules & { edit_rules: string };

/**
 * The feedback box under an assembled output. Two things live here:
 *  - Notes: "what's wrong at 31.2s". Saved as learning events against the exact cut decisions, so the cutter can be
 *    trained on them. Listed below the box so the editor can see what has already been said.
 *  - Rules: the pacing knobs the cutter applies on the next assemble, and the free-text style guide. Shared across
 *    boards (admin edits them; everyone sees them).
 */
export function EditNotes({ boardId, target, canEdit, isAdmin, className }: { boardId: string; target: "aroll" | "final"; canEdit: boolean; isAdmin: boolean; className?: string }) {
  const [notes, setNotes] = useState<EditNote[]>([]);
  const [text, setText] = useState("");
  const [at, setAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rules, setRules] = useState<RulesPayload | null>(null);
  const [rulesDirty, setRulesDirty] = useState(false);
  const [savingRules, setSavingRules] = useState(false);

  useEffect(() => {
    let alive = true;
    void api<{ notes: EditNote[] }>(`/api/boards/${boardId}/feedback?target=${target}`)
      .then((r) => alive && setNotes(r.notes))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [boardId, target]);

  useEffect(() => {
    if (!rulesOpen || rules) return;
    void api<Record<string, unknown>>("/api/settings")
      .then((s) =>
        setRules({
          edit_rules: String(s.edit_rules ?? ""),
          min_broll_s: Number(s.cut_min_broll_s ?? 2),
          min_return_s: Number(s.cut_min_return_s ?? 2),
          head_pad_s: Number(s.cut_head_pad_s ?? 0.12),
          tail_pad_s: Number(s.cut_tail_pad_s ?? 0.18),
        }),
      )
      .catch((e) => toast.error("Couldn't load the cut rules", { description: e instanceof Error ? e.message : String(e) }));
  }, [rulesOpen, rules]);

  async function saveNote() {
    const note = text.trim();
    if (!note) return;
    setSaving(true);
    try {
      const atNum = at.trim() === "" ? null : Number(at);
      const res = await api<{ note: EditNote | null }>(`/api/boards/${boardId}/feedback`, { method: "POST", json: { target_type: target, note, at_s: Number.isFinite(atNum as number) ? atNum : null } });
      if (res.note) setNotes((cur) => [res.note!, ...cur]);
      setText("");
      setAt("");
      toast.success("Note saved", { description: "Logged against this cut. It feeds the cutter's next version." });
    } catch (e) {
      toast.error("Couldn't save the note", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  async function saveRules() {
    if (!rules) return;
    setSavingRules(true);
    try {
      await api("/api/settings", { method: "PUT", json: { edit_rules: rules.edit_rules, cut_min_broll_s: rules.min_broll_s, cut_min_return_s: rules.min_return_s, cut_head_pad_s: rules.head_pad_s, cut_tail_pad_s: rules.tail_pad_s } });
      setRulesDirty(false);
      toast.success("Cut rules saved", { description: "Applied on the next assemble or re-cut." });
    } catch (e) {
      toast.error("Couldn't save the rules", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSavingRules(false);
    }
  }

  const label = target === "aroll" ? "this A-roll cut" : "this finished ad";

  return (
    <div className={cn("space-y-2 rounded-[6px] border border-hairline bg-field/40 p-2.5", className)}>
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.08em] text-cream-2">
        <MessageSquareText className="size-3" /> Notes on {label}
        <span className="ml-auto font-normal normal-case tracking-normal text-muted">{notes.length ? `${notes.length} saved` : "training data for the cutter"}</span>
      </div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={!canEdit}
        rows={2}
        placeholder={target === "aroll" ? "e.g. 0:14 she breathes for a second before the line; cut tighter. 0:41 clipped her last word." : "e.g. 0:31 back to her too early, stay on the product. 0:52 that B-roll is the wrong beat for this line."}
        className="text-[12px] leading-snug"
      />
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.08em] text-muted">
          At (s)
          <Input type="number" min={0} step={0.1} value={at} onChange={(e) => setAt(e.target.value)} disabled={!canEdit} placeholder="—" className="h-7 w-20 font-mono text-[11px]" />
        </label>
        <Button size="sm" variant="gold" disabled={!canEdit || saving || !text.trim()} onClick={() => void saveNote()}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />} Save note
        </Button>
        <button type="button" onClick={() => setRulesOpen((v) => !v)} className="ml-auto flex items-center gap-1 text-[11px] text-cream-2 hover:text-cream">
          <SlidersHorizontal className="size-3" /> Cut rules <ChevronDown className={cn("size-3 transition-transform", rulesOpen && "rotate-180")} />
        </button>
      </div>

      {notes.length ? (
        <ul className="max-h-40 space-y-1 overflow-y-auto border-t border-hairline pt-2">
          {notes.map((n) => (
            <li key={n.id} className="flex gap-2 text-[11px] leading-snug text-cream-2">
              <span className="shrink-0 font-mono text-[10px] text-muted">{n.at_s != null ? `${n.at_s}s` : "—"}</span>
              <span className="min-w-0 flex-1">{n.note}</span>
              <span className="shrink-0 text-[10px] text-muted">{new Date(n.created_at).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {rulesOpen ? (
        <div className="space-y-2 border-t border-hairline pt-2">
          {!rules ? (
            <p className="text-[11px] text-muted">Loading…</p>
          ) : (
            <>
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
                        setRulesDirty(true);
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
                  rows={5}
                  onChange={(e) => {
                    setRules({ ...rules, edit_rules: e.target.value });
                    setRulesDirty(true);
                  }}
                  className="mt-0.5 text-[12px] leading-snug normal-case tracking-normal"
                />
              </label>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={!isAdmin || !rulesDirty || savingRules} onClick={() => void saveRules()}>
                  {savingRules ? <Loader2 className="animate-spin" /> : <Save />} Save rules
                </Button>
                <span className="text-[11px] text-muted">{isAdmin ? "Shared across all boards. Knobs apply on the next assemble; the style guide is what the editor brain reads." : "Only an admin can change these."}</span>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

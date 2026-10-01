"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { categoryLabels, categoryOrder, familyMembers, pickerEntries, type ModelConfig } from "@/config/models.config";
import { inputTypeLabels, priceLabel } from "@/lib/pricing-labels";
import { cn } from "@/lib/utils";

function ModelCard({ model, selected, onSelect }: { model: ModelConfig; selected: boolean; onSelect: () => void }) {
  const tiers = familyMembers(model);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group relative flex h-full flex-col rounded-[8px] border bg-surface p-4 text-left transition-colors hover:bg-elevated",
        selected ? "border-gold/70 shadow-[inset_3px_0_0_0_var(--gold)]" : "border-hairline",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-serif text-lg leading-tight text-cream">{model.name}</span>
        <span className="shrink-0 font-mono text-xs text-gold">{priceLabel(model)}</span>
      </div>
      <p className="mt-1.5 text-[13px] leading-snug text-cream-2">{model.description}</p>
      <div className="mt-auto flex flex-wrap gap-1.5 pt-3">
        {model.inputTypes.map((t) => (
          <span key={t} className="rounded-full border border-hairline px-2 py-0.5 text-[10px] text-muted">
            {inputTypeLabels[t]}
          </span>
        ))}
        {tiers.length > 1 ? (
          <span className="rounded-full border border-hairline px-2 py-0.5 text-[10px] text-muted">{tiers.map((t) => t.tier).join(" / ")}</span>
        ) : null}
      </div>
    </button>
  );
}

export function ModelPicker({ value, onChange }: { value: ModelConfig; onChange: (m: ModelConfig) => void }) {
  const [open, setOpen] = useState(false);
  const entries = pickerEntries();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 rounded-[8px] border border-hairline bg-surface px-4 py-3 text-left transition-colors hover:bg-elevated"
        >
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.1em] text-muted">{categoryLabels[value.category]}</div>
            <div className="truncate font-serif text-xl text-cream">
              {value.name}
              {value.tier && familyMembers(value).length > 1 ? <span className="ml-2 font-sans text-sm text-cream-2">{value.tier}</span> : null}
            </div>
            <div className="truncate text-xs text-cream-2">{value.description}</div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <span className="font-mono text-xs text-gold">{priceLabel(value)}</span>
            <ChevronDown className="size-4 text-cream-2" />
          </div>
        </button>
      </DialogTrigger>
      <DialogContent title="Choose a model" description="Prices are per generation, pulled from the model config." wide>
        <div className="space-y-8 pb-2">
          {categoryOrder.map((cat) => {
            const inCat = entries.filter((m) => m.category === cat);
            if (!inCat.length) return null;
            return (
              <section key={cat}>
                <h3 className="mb-3 text-xs uppercase tracking-[0.12em] text-cream-2">{categoryLabels[cat]}</h3>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {inCat.map((m) => (
                    <ModelCard
                      key={m.id}
                      model={m}
                      selected={m.family ? m.family === value.family : m.id === value.id}
                      onSelect={() => {
                        onChange(m.family && m.family === value.family ? value : m);
                        setOpen(false);
                      }}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

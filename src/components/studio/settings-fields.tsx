"use client";

import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import type { FieldSpec, ModelConfig, SettingValue } from "@/config/models.config";
import { fieldActive } from "@/lib/generation-params";

export type Settings = Record<string, SettingValue | undefined>;

/** A voice from the signed-in ElevenLabs library, fetched server-side and passed into the form. */
export type VoiceOption = { value: string; label: string; hint?: string; previewUrl?: string };

/** A field's choices: from this file, or from the account (ElevenLabs voices). */
const choicesFor = (field: FieldSpec, voices?: VoiceOption[]) => (field.optionsFrom === "voices" ? (voices ?? []) : (field.options ?? []));

/** The model's defaults, keeping any current values that still apply (e.g. the voice when switching tiers). */
export function reconcileSettings(current: Settings, model: ModelConfig, voices?: VoiceOption[]): Settings {
  const next: Settings = {};
  for (const f of model.options.fields ?? []) {
    const choices = choicesFor(f, voices);
    const v = current[f.key];
    const valid = v !== undefined && (f.type !== "select" || choices.some((o) => o.value === String(v)));
    // Account-supplied lists have no default in the config, so fall back to the first voice.
    next[f.key] = valid ? v : (f.default ?? (f.optionsFrom === "voices" ? choices[0]?.value : undefined));
  }
  return next;
}

/** Only the settings the model declares and currently shows. */
export function settingsForRequest(settings: Settings, model: ModelConfig): Record<string, SettingValue> | undefined {
  const fields = model.options.fields;
  if (!fields?.length) return undefined;
  const out: Record<string, SettingValue> = {};
  for (const f of fields) {
    const v = settings[f.key];
    if (v !== undefined && v !== "" && fieldActive(f, settings)) out[f.key] = v;
  }
  return out;
}

function VoicePreview({ previewUrl }: { previewUrl: string }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  // Keyed by voice in the parent, so switching voices unmounts this and stops the old preview.
  useEffect(() => () => audio.current?.pause(), []);

  const toggle = () => {
    if (playing) {
      audio.current?.pause();
      return;
    }
    audio.current?.pause();
    audio.current = new Audio(previewUrl);
    audio.current.onended = audio.current.onpause = () => setPlaying(false);
    void audio.current.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };

  return (
    <button type="button" onClick={toggle} className="flex shrink-0 items-center gap-1 text-xs text-cream-2 hover:text-cream" aria-label={playing ? "Stop preview" : "Preview voice"}>
      {playing ? <Pause className="size-3" /> : <Play className="size-3" />} {playing ? "Stop" : "Preview"}
    </button>
  );
}

function Field({
  field,
  value,
  onChange,
  voices,
}: {
  field: FieldSpec;
  value: SettingValue | undefined;
  onChange: (v: SettingValue | undefined) => void;
  voices?: VoiceOption[];
}) {
  const id = `setting-${field.key}`;
  const label = (
    <Label htmlFor={id}>
      {field.label} {field.required ? null : field.type !== "toggle" && field.default === undefined ? <span className="normal-case tracking-normal text-muted">(optional)</span> : null}
    </Label>
  );
  const help = field.help ? <p className="text-[11px] leading-snug text-muted">{field.help}</p> : null;

  if (field.type === "toggle") {
    return (
      <label className="flex cursor-pointer items-center gap-2.5 text-sm text-cream-2">
        <input id={id} type="checkbox" className="size-4 accent-[var(--gold)]" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        {field.label}
      </label>
    );
  }

  if (field.type === "select" && (field.options || field.optionsFrom)) {
    const choices = choicesFor(field, voices);
    const current = value != null ? String(value) : undefined;
    const hint = choices.find((o) => o.value === current)?.hint;
    const preview = (choices.find((o) => o.value === current) as VoiceOption | undefined)?.previewUrl;
    if (field.optionsFrom === "voices" && !choices.length) {
      return (
        <div className="space-y-2">
          {label}
          <p className="text-[11px] leading-snug text-danger">Couldn&apos;t load your ElevenLabs voices. Check ELEVENLABS_API_KEY.</p>
        </div>
      );
    }
    return (
      <div className="space-y-2">
        {label}
        {choices.length <= 4 ? (
          <Segmented aria-label={field.label} value={current} options={choices.map((o) => ({ value: o.value, label: o.label ?? o.value }))} onChange={(v) => onChange(v)} />
        ) : (
          <div className="flex items-center gap-3">
            <NativeSelect id={id} value={current ?? ""} onChange={(e) => onChange(e.target.value)} className="min-w-0 flex-1">
              {choices.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label ?? o.value}
                  {o.hint ? ` — ${o.hint}` : ""}
                </option>
              ))}
            </NativeSelect>
            {preview ? <VoicePreview key={current} previewUrl={preview} /> : null}
          </div>
        )}
        {hint && choices.length <= 4 ? <p className="text-[11px] leading-snug text-muted">{hint}</p> : null}
        {help}
      </div>
    );
  }

  if (field.type === "number") {
    return (
      <div className="space-y-2">
        {label}
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={field.min}
          max={field.max}
          step={field.step}
          value={value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          className="font-mono"
        />
        {help}
      </div>
    );
  }

  const text = typeof value === "string" ? value : "";
  const count = field.maxLength && text.length > field.maxLength * 0.8 ? <span className="font-mono text-[10px] text-muted">{text.length}/{field.maxLength}</span> : null;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        {label}
        {count}
      </div>
      {field.type === "textarea" ? (
        <Textarea id={id} rows={2} value={text} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input id={id} value={text} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
      {help}
    </div>
  );
}

/** Renders a model's declared settings; `advanced` picks the fields shown under the Advanced toggle. */
export function SettingsFields({
  model,
  value,
  onChange,
  advanced = false,
  voices,
}: {
  model: ModelConfig;
  value: Settings;
  onChange: (v: Settings) => void;
  advanced?: boolean;
  voices?: VoiceOption[];
}) {
  const fields = (model.options.fields ?? []).filter((f) => Boolean(f.advanced) === advanced && fieldActive(f, value));
  if (!fields.length) return null;
  return (
    <div className={advanced ? "space-y-4" : "space-y-5"}>
      {fields.map((f) => (
        <Field key={f.key} field={f} value={value[f.key]} voices={voices} onChange={(v) => onChange({ ...value, [f.key]: v })} />
      ))}
    </div>
  );
}

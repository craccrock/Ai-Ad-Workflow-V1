"use client";

import { ChevronLeft, ChevronRight, Copy, Download, FolderOpen, ImagePlus, Loader2, RotateCw, Sparkles, Star, Trash2, Upload, Wand2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { LibraryPicker } from "@/components/library/library-picker";
import { Button } from "@/components/ui/button";
import { NativeSelect, Textarea } from "@/components/ui/input";
import { Badge, Card } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { ImageThumb } from "@/components/ui/thumb";
import { getModel } from "@/config/models.config";
import { STARTER_DEFAULT_MODELS, STARTER_MAX_IMAGES, STARTER_MODEL_IDS } from "@/config/starter";
import { api, downloadFile, type ApiGeneration } from "@/lib/client-api";
import { estimateCost } from "@/lib/generation-params";
import { uploadMedia } from "@/lib/upload";
import { cn, formatUsd } from "@/lib/utils";

export type StarterTake = ApiGeneration & { favorite: boolean; direction: string | null };
type TrayImage = { id: string; url: string; name: string; send: boolean };
type Draft = { direction: string; prompt: string; models: string[]; variants: number; aspect: string; resolution: string; images: TrayImage[] };

const DRAFT_KEY = "starter-draft-v1";
const DRAG_URL = "application/x-starter-url";
const DRAG_TRAY = "application/x-starter-tray";
const ASPECTS = ["9:16", "4:5", "3:4", "1:1", "16:9"];
const RESOLUTIONS = ["1K", "2K", "4K"];
const EMPTY: Draft = { direction: "", prompt: "", models: STARTER_DEFAULT_MODELS, variants: 2, aspect: "9:16", resolution: "2K", images: [] };

const inFlight = (t: StarterTake) => t.status === "queued" || t.status === "processing";
const uid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random()).slice(2));

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return EMPTY;
    const d = JSON.parse(raw) as Partial<Draft>;
    return { ...EMPTY, ...d, models: (d.models ?? EMPTY.models).filter((m) => (STARTER_MODEL_IDS as readonly string[]).includes(m)), images: Array.isArray(d.images) ? d.images.slice(0, STARTER_MAX_IMAGES) : [] };
  } catch {
    return EMPTY;
  }
}

export function StarterStudio({ initialTakes, userId, isAdmin }: { initialTakes: StarterTake[]; userId: string; isAdmin: boolean }) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [hydrated, setHydrated] = useState(false);
  const [takes, setTakes] = useState<StarterTake[]>(initialTakes);
  const [writing, setWriting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [picker, setPicker] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [filter, setFilter] = useState<"all" | "favorites" | string>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = useCallback((patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch })), []);

  // Draft lives in this browser only (a convenience, not a record): restore once, then save on change.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore from localStorage after mount
    setDraft(loadDraft());
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* private window or storage blocked: the page works without it */
    }
  }, [draft, hydrated]);

  // Poll whatever is still rendering.
  const pending = useMemo(() => takes.filter(inFlight).map((t) => t.id), [takes]);
  const pendingKey = pending.join(",");
  useEffect(() => {
    if (!pendingKey) return;
    const ids = pendingKey.split(",");
    const t = setInterval(() => {
      for (const id of ids) {
        void api<ApiGeneration>(`/api/generate/${id}`)
          .then((g) => setTakes((cur) => cur.map((x) => (x.id === id ? { ...x, ...g } : x))))
          .catch(() => {});
      }
    }, 3000);
    return () => clearInterval(t);
  }, [pendingKey]);

  // ── image tray ──
  const addImage = useCallback((url: string, name: string, send = true) => {
    setDraft((d) => {
      if (d.images.some((i) => i.url === url)) return d;
      if (d.images.length >= STARTER_MAX_IMAGES) {
        toast.error(`Up to ${STARTER_MAX_IMAGES} images`);
        return d;
      }
      return { ...d, images: [...d.images, { id: uid(), url, name, send }] };
    });
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      const imgs = files.filter((f) => f.type.startsWith("image/"));
      if (!imgs.length) return;
      setUploading(true);
      try {
        for (const f of imgs) {
          const m = await uploadMedia(f, userId);
          addImage(m.url, m.filename);
        }
      } catch (e) {
        toast.error("Upload failed", { description: e instanceof Error ? e.message : String(e) });
      } finally {
        setUploading(false);
      }
    },
    [addImage, userId],
  );

  // Paste an image straight from the clipboard (a screenshot, or "Copy image" from a web page).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      e.preventDefault();
      void addFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFiles]);

  function onTrayDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const url = e.dataTransfer.getData(DRAG_URL);
    if (url) return addImage(url, "generated take");
    if (e.dataTransfer.files.length) void addFiles(Array.from(e.dataTransfer.files));
  }

  function moveImage(from: number, to: number) {
    setDraft((d) => {
      if (from === to || from < 0 || to < 0 || from >= d.images.length || to >= d.images.length) return d;
      const images = [...d.images];
      const [it] = images.splice(from, 1);
      images.splice(to, 0, it);
      return { ...d, images };
    });
  }

  const sentUrls = draft.images.filter((i) => i.send).map((i) => i.url);

  // ── actions ──
  async function writePrompt() {
    if (!draft.direction.trim()) return toast.error("Say what you want first");
    setWriting(true);
    try {
      const res = await api<{ prompt: string }>("/api/starter/prompt", { method: "POST", json: { direction: draft.direction, images: draft.images.map((i) => ({ url: i.url, send: i.send })), current_prompt: draft.prompt.trim() || undefined } });
      set({ prompt: res.prompt });
      toast.success(draft.prompt.trim() ? "Prompt revised" : "Prompt written");
    } catch (e) {
      toast.error("Couldn't write the prompt", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setWriting(false);
    }
  }

  async function run(body: { prompt: string; models: string[]; variants: number; aspect_ratio: string; resolution?: string; image_urls: string[]; direction?: string }) {
    const res = await api<{ takes: StarterTake[]; errors: string[] }>("/api/starter", { method: "POST", json: body });
    setTakes((cur) => [...res.takes, ...cur]);
    if (res.errors.length) toast.error("Some models didn't start", { description: res.errors.join(" | ") });
    return res.takes.length;
  }

  async function generate() {
    if (draft.prompt.trim().length < 3) return toast.error("Write or paste a prompt first");
    if (!draft.models.length) return toast.error("Tick at least one model");
    setGenerating(true);
    try {
      const n = await run({ prompt: draft.prompt.trim(), models: draft.models, variants: draft.variants, aspect_ratio: draft.aspect, resolution: draft.resolution, image_urls: sentUrls, direction: draft.direction.trim() || undefined });
      toast.success(`${n} image${n === 1 ? "" : "s"} generating`);
    } catch (e) {
      toast.error("Couldn't generate", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setGenerating(false);
    }
  }

  async function rerun(t: StarterTake) {
    try {
      await run({ prompt: t.prompt ?? "", models: [t.model], variants: 1, aspect_ratio: t.aspect_ratio ?? "9:16", resolution: t.resolution ?? undefined, image_urls: (t.params?.image_urls as string[] | undefined) ?? [], direction: t.direction ?? undefined });
      toast.success("Re-running with the same prompt and references");
    } catch (e) {
      toast.error("Couldn't re-run", { description: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Load a take's prompt, references, model and frame back into the composer. */
  function reuse(t: StarterTake) {
    const refs = ((t.params?.image_urls as string[] | undefined) ?? []).slice(0, STARTER_MAX_IMAGES);
    set({
      prompt: t.prompt ?? "",
      direction: t.direction ?? draft.direction,
      models: (STARTER_MODEL_IDS as readonly string[]).includes(t.model) ? [t.model] : draft.models,
      aspect: t.aspect_ratio ?? draft.aspect,
      resolution: t.resolution ?? draft.resolution,
      images: refs.map((url, i) => ({ id: uid(), url, name: `reference ${i + 1}`, send: true })),
    });
    setOpenId(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
    toast.success("Loaded into the composer");
  }

  async function toggleFavorite(t: StarterTake) {
    setTakes((cur) => cur.map((x) => (x.id === t.id ? { ...x, favorite: !t.favorite } : x)));
    try {
      await api(`/api/starter/${t.id}`, { method: "PATCH", json: { favorite: !t.favorite } });
    } catch (e) {
      setTakes((cur) => cur.map((x) => (x.id === t.id ? { ...x, favorite: t.favorite } : x)));
      toast.error("Couldn't save the star", { description: e instanceof Error ? e.message : String(e) });
    }
  }

  async function remove(t: StarterTake) {
    if (!window.confirm("Delete this image for good? This can't be undone.")) return;
    try {
      await api(`/api/starter/${t.id}`, { method: "DELETE" });
      setTakes((cur) => cur.filter((x) => x.id !== t.id));
      setOpenId((id) => (id === t.id ? null : id));
      toast.success("Deleted");
    } catch (e) {
      toast.error("Couldn't delete", { description: e instanceof Error ? e.message : String(e) });
    }
  }

  const addTakeAsReference = (t: StarterTake) => {
    if (!t.result_url) return;
    addImage(t.result_url, `${t.model_display_name} take`);
    toast.success("Added to the image tray");
  };

  // ── derived ──
  const cost = useMemo(() => {
    let total = 0;
    for (const id of draft.models) {
      const m = getModel(id);
      if (!m) continue;
      total += estimateCost(m, { prompt: "x", image_urls: sentUrls, reference_image_urls: [], reference_video_urls: [], reference_audio_urls: [], elements: [], settings: {}, aspect_ratio: draft.aspect, resolution: draft.resolution }, draft.variants).total ?? 0;
    }
    return total;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sentUrls is derived from draft.images
  }, [draft.models, draft.variants, draft.aspect, draft.resolution, draft.images]);
  const count = draft.models.length * draft.variants;

  const shown = useMemo(() => takes.filter((t) => (filter === "all" ? true : filter === "favorites" ? t.favorite : t.model === filter)), [takes, filter]);
  const openIndex = openId ? shown.findIndex((t) => t.id === openId) : -1;
  const open = openIndex >= 0 ? shown[openIndex] : null;
  const step = useCallback(
    (d: number) => {
      if (openIndex < 0 || !shown.length) return;
      setOpenId(shown[(openIndex + d + shown.length) % shown.length].id);
    },
    [openIndex, shown],
  );
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenId(null);
      if (e.key === "ArrowRight") step(1);
      if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, step]);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── 1. Brief → Claude ── */}
        <Card className="space-y-3 p-4">
          <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.08em] text-gold">
            <Sparkles className="size-3" /> 1 · Brief
            <span className="ml-auto font-normal normal-case tracking-normal text-muted">Claude turns this into the prompt</span>
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onTrayDrop}
            className={cn("rounded-[8px] border border-dashed p-2 transition-colors", dragOver ? "border-gold bg-gold/5" : "border-field-border bg-field/40")}
          >
            <div className="flex flex-wrap gap-2">
              {draft.images.map((img, i) => {
                const n = draft.images.slice(0, i + 1).filter((x) => x.send).length;
                return (
                  <div
                    key={img.id}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData(DRAG_TRAY, String(i))}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      const from = e.dataTransfer.getData(DRAG_TRAY);
                      if (from === "") return;
                      e.preventDefault();
                      e.stopPropagation();
                      setDragOver(false);
                      moveImage(Number(from), i);
                    }}
                    className="group relative w-[92px] cursor-grab"
                    title={img.send ? `Sent to the image model as image ${n}. Drag to reorder.` : "Look only: Claude sees it, the image model doesn't."}
                  >
                    <div className={cn("relative aspect-[3/4] overflow-hidden rounded-[6px] border bg-field", img.send ? "border-gold/60" : "border-hairline opacity-80")}>
                      <ImageThumb src={img.url} alt={img.name} sizes="92px" className="object-cover" />
                      <span className={cn("absolute left-1 top-1 rounded-[3px] px-1 font-mono text-[10px]", img.send ? "bg-gold text-navy" : "bg-navy/80 text-cream-2")}>{img.send ? `image ${n}` : "look"}</span>
                      <button type="button" aria-label="Remove image" onClick={() => set({ images: draft.images.filter((x) => x.id !== img.id) })} className="absolute right-1 top-1 rounded-full bg-navy/80 p-0.5 text-cream-2 hover:text-cream">
                        <X className="size-3" />
                      </button>
                    </div>
                    <label className="mt-1 flex items-center gap-1 text-[10px] text-cream-2">
                      <input type="checkbox" checked={img.send} onChange={(e) => set({ images: draft.images.map((x) => (x.id === img.id ? { ...x, send: e.target.checked } : x)) })} className="accent-gold" />
                      Send to model
                    </label>
                  </div>
                );
              })}
              {draft.images.length < STARTER_MAX_IMAGES ? (
                <div className="flex aspect-[3/4] w-[92px] flex-col items-center justify-center gap-1.5 rounded-[6px] border border-hairline bg-field text-[11px] text-cream-2">
                  {uploading ? (
                    <Loader2 className="size-4 animate-spin text-gold" />
                  ) : (
                    <>
                      <button type="button" onClick={() => fileRef.current?.click()} className="flex items-center gap-1 hover:text-cream">
                        <Upload className="size-3.5" /> Upload
                      </button>
                      <button type="button" onClick={() => setPicker(true)} className="flex items-center gap-1 hover:text-cream">
                        <FolderOpen className="size-3.5" /> Library
                      </button>
                    </>
                  )}
                </div>
              ) : null}
            </div>
            <p className="mt-2 text-[11px] leading-snug text-muted">
              Drop, paste (Ctrl+V) or upload example images, or drag any take up from the gallery. Ticked images go to the image model as references in this order; unticked ones are for Claude&apos;s eyes only.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              hidden
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </div>

          <Textarea
            value={draft.direction}
            onChange={(e) => set({ direction: e.target.value })}
            rows={4}
            placeholder="e.g. Take the woman in image 1 and make a starter image of her sitting on her bed in her bedroom, UGC yapper style, phone close to her face as if she's recording herself."
            className="text-[13px] leading-snug"
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void writePrompt();
            }}
          />
          <div className="flex items-center gap-2">
            <Button variant="gold" size="sm" disabled={writing || !draft.direction.trim()} onClick={() => void writePrompt()}>
              {writing ? <Loader2 className="animate-spin" /> : <Wand2 />} {writing ? "Writing…" : draft.prompt.trim() ? "Revise prompt with Claude" : "Write prompt with Claude"}
            </Button>
            <span className="text-[11px] text-muted">{draft.prompt.trim() ? "Revises the prompt on the right using this direction." : "Ctrl+Enter"}</span>
          </div>
        </Card>

        {/* ── 2. Prompt → models ── */}
        <Card className="space-y-3 p-4">
          <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.08em] text-gold">
            <ImagePlus className="size-3" /> 2 · Prompt &amp; generate
            {draft.prompt ? (
              <button
                type="button"
                className="ml-auto flex items-center gap-1 font-normal normal-case tracking-normal text-muted hover:text-cream"
                onClick={() => {
                  void navigator.clipboard.writeText(draft.prompt).then(() => toast.success("Prompt copied"));
                }}
              >
                <Copy className="size-3" /> Copy
              </button>
            ) : null}
          </div>
          <Textarea value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} rows={9} placeholder="The prompt Claude writes lands here. Edit it freely, or paste your own." className="text-[13px] leading-snug" />

          <div className="flex flex-wrap gap-2">
            {STARTER_MODEL_IDS.map((id) => {
              const m = getModel(id);
              if (!m) return null;
              const on = draft.models.includes(id);
              const each = estimateCost(m, { prompt: "x", image_urls: [], reference_image_urls: [], reference_video_urls: [], reference_audio_urls: [], elements: [], settings: {}, aspect_ratio: draft.aspect, resolution: draft.resolution }, 1).perGeneration;
              return (
                <label key={id} title={m.description} className={cn("flex cursor-pointer items-center gap-2 rounded-[6px] border px-2.5 py-1.5 text-[12px]", on ? "border-gold/60 bg-gold/5 text-cream" : "border-hairline text-cream-2 hover:text-cream")}>
                  <input type="checkbox" checked={on} onChange={(e) => set({ models: e.target.checked ? [...draft.models, id] : draft.models.filter((x) => x !== id) })} className="accent-gold" />
                  {m.name}
                  <span className="font-mono text-[10px] text-muted">{formatUsd(each)}</span>
                </label>
              );
            })}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="text-[10px] uppercase tracking-[0.08em] text-muted">
              Frame
              <NativeSelect value={draft.aspect} onChange={(e) => set({ aspect: e.target.value })} className="mt-0.5 h-8 text-[12px]">
                {ASPECTS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="text-[10px] uppercase tracking-[0.08em] text-muted">
              Size
              <NativeSelect value={draft.resolution} onChange={(e) => set({ resolution: e.target.value })} className="mt-0.5 h-8 text-[12px]">
                {RESOLUTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <div className="text-[10px] uppercase tracking-[0.08em] text-muted">
              Per model
              <Segmented<number> size="sm" className="mt-0.5" value={draft.variants} onChange={(v) => set({ variants: v })} options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))} aria-label="Images per model" />
            </div>
            <Button variant="gold" className="ml-auto" disabled={generating || draft.prompt.trim().length < 3 || !draft.models.length} onClick={() => void generate()}>
              {generating ? <Loader2 className="animate-spin" /> : <Sparkles />} Generate {count} image{count === 1 ? "" : "s"} · {formatUsd(cost)}
            </Button>
          </div>
          <p className="text-[11px] text-muted">
            {sentUrls.length ? `${sentUrls.length} reference image${sentUrls.length === 1 ? "" : "s"} from the tray go with the prompt.` : "No reference images: text-to-image."} All jobs run at once.
          </p>
        </Card>
      </div>

      {/* ── 3. Takes ── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-serif text-xl text-cream">Takes</h2>
          <span className="text-[12px] text-muted">
            {takes.length} total{pending.length ? ` · ${pending.length} rendering` : ""}
          </span>
          <Segmented<string>
            size="sm"
            className="ml-auto"
            value={filter}
            onChange={setFilter}
            aria-label="Filter takes"
            options={[{ value: "all", label: "All" }, { value: "favorites", label: "★ Starred" }, ...STARTER_MODEL_IDS.map((id) => ({ value: id as string, label: getModel(id)?.name.replace("Nano Banana ", "NB ") ?? id }))]}
          />
        </div>
        {shown.length ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            {shown.map((t) => (
              <TakeCard key={t.id} t={t} canDelete={isAdmin || t.user_id === userId} onOpen={() => setOpenId(t.id)} onRef={() => addTakeAsReference(t)} onReuse={() => reuse(t)} onRerun={() => void rerun(t)} onFav={() => void toggleFavorite(t)} onDelete={() => void remove(t)} />
            ))}
          </div>
        ) : (
          <Card className="p-8 text-center text-[13px] text-muted">{takes.length ? "Nothing matches this filter." : "No starter images yet. Write a brief, get a prompt, and generate."}</Card>
        )}
      </section>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4" onClick={() => setOpenId(null)} role="dialog" aria-modal="true">
          <button type="button" aria-label="Previous" onClick={(e) => (e.stopPropagation(), step(-1))} className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-navy/80 p-2 text-cream hover:bg-navy">
            <ChevronLeft />
          </button>
          <button type="button" aria-label="Next" onClick={(e) => (e.stopPropagation(), step(1))} className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-navy/80 p-2 text-cream hover:bg-navy">
            <ChevronRight />
          </button>
          <div className="flex max-h-full w-full max-w-5xl flex-col gap-4 md:flex-row" onClick={(e) => e.stopPropagation()}>
            <div className="flex min-h-0 flex-1 items-center justify-center">
              {open.result_url ? (
                // eslint-disable-next-line @next/next/no-img-element -- full-size view of one image
                <img src={open.result_url} alt="" className="max-h-[86vh] max-w-full rounded-[8px] object-contain" />
              ) : (
                <div className="flex aspect-[9/16] h-[60vh] items-center justify-center rounded-[8px] bg-field text-cream-2">{open.status === "failed" ? "Failed" : <Loader2 className="animate-spin text-gold" />}</div>
              )}
            </div>
            <div className="w-full shrink-0 space-y-3 overflow-y-auto rounded-[8px] bg-surface p-4 md:w-[320px]">
              <div className="flex items-center gap-2">
                <Badge tone="gold">{open.model_display_name}</Badge>
                <span className="text-[11px] text-muted">
                  {open.aspect_ratio} · {open.resolution} · {openIndex + 1}/{shown.length}
                </span>
                <button type="button" aria-label="Close" onClick={() => setOpenId(null)} className="ml-auto text-cream-2 hover:text-cream">
                  <X className="size-4" />
                </button>
              </div>
              {open.status === "failed" ? <p className="text-[12px] text-danger">{open.error}</p> : null}
              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" variant="gold" disabled={!open.result_url} onClick={() => addTakeAsReference(open)}>
                  <ImagePlus /> Use as reference
                </Button>
                <Button size="sm" variant="outline" onClick={() => reuse(open)}>
                  <Wand2 /> Reuse setup
                </Button>
                <Button size="sm" variant="outline" onClick={() => void rerun(open)}>
                  <RotateCw /> Re-run
                </Button>
                <Button size="sm" variant="outline" onClick={() => void toggleFavorite(open)}>
                  <Star className={cn(open.favorite && "fill-gold text-gold")} /> {open.favorite ? "Starred" : "Star"}
                </Button>
                <Button size="sm" variant="outline" disabled={!open.result_url} onClick={() => void downloadFile(open.result_url!, `starter-${open.model}-${open.id.slice(0, 8)}.png`)}>
                  <Download /> Download
                </Button>
                {isAdmin || open.user_id === userId ? (
                  <Button size="sm" variant="danger" onClick={() => void remove(open)}>
                    <Trash2 /> Delete
                  </Button>
                ) : null}
              </div>
              {((open.params?.image_urls as string[] | undefined) ?? []).length ? (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-muted">References used</div>
                  <div className="flex flex-wrap gap-1.5">
                    {((open.params?.image_urls as string[]) ?? []).map((u, i) => (
                      <button key={u + i} type="button" title="Add to the image tray" onClick={() => addImage(u, `reference ${i + 1}`)} className="relative size-12 overflow-hidden rounded-[4px] border border-hairline hover:border-gold">
                        <ImageThumb src={u} alt="" sizes="48px" className="object-cover" />
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {open.direction ? (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-muted">Direction</div>
                  <p className="text-[12px] leading-snug text-cream-2">{open.direction}</p>
                </div>
              ) : null}
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-muted">Prompt</div>
                <p className="whitespace-pre-wrap text-[12px] leading-snug text-cream-2">{open.prompt}</p>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <LibraryPicker type="image" open={picker} onOpenChange={setPicker} onPick={(m) => addImage(m.url, m.filename)} title="Choose an image" />
    </div>
  );
}

function TakeCard({ t, canDelete, onOpen, onRef, onReuse, onRerun, onFav, onDelete }: { t: StarterTake; canDelete: boolean; onOpen: () => void; onRef: () => void; onReuse: () => void; onRerun: () => void; onFav: () => void; onDelete: () => void }) {
  const done = t.status === "completed" && t.result_url;
  const act = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div
      draggable={!!done}
      onDragStart={(e) => {
        if (!t.result_url) return;
        e.dataTransfer.setData(DRAG_URL, t.result_url);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={onOpen}
      className={cn("group relative aspect-[9/16] cursor-pointer overflow-hidden rounded-[8px] border bg-field", t.favorite ? "border-gold/70" : "border-hairline hover:border-field-border")}
      title={done ? "Click to open. Drag onto the image tray to use as a reference." : undefined}
    >
      {done ? (
        <ImageThumb src={t.result_url!} alt={t.prompt?.slice(0, 80) ?? "starter take"} sizes="(min-width:1280px) 16vw, (min-width:768px) 25vw, 50vw" className="object-cover" />
      ) : t.status === "failed" ? (
        <div className="flex h-full flex-col items-center justify-center gap-1 p-3 text-center text-[11px] text-danger">
          Failed
          <span className="line-clamp-4 text-[10px] text-muted">{t.error}</span>
        </div>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-[11px] text-cream-2">
          <Loader2 className="size-5 animate-spin text-gold" />
          {t.status === "queued" ? "Queued" : "Rendering"}
        </div>
      )}
      <span className="absolute left-1.5 top-1.5 rounded-[3px] bg-navy/80 px-1.5 py-0.5 text-[10px] text-cream-2">{t.model_display_name.replace("Nano Banana ", "NB ")}</span>
      <button type="button" aria-label={t.favorite ? "Unstar" : "Star"} onClick={act(onFav)} className={cn("absolute right-1.5 top-1.5 rounded-full bg-navy/80 p-1", t.favorite ? "text-gold" : "text-cream-2 opacity-0 hover:text-cream group-hover:opacity-100")}>
        <Star className={cn("size-3.5", t.favorite && "fill-gold")} />
      </button>
      <div className="absolute inset-x-0 bottom-0 flex translate-y-full items-center justify-center gap-1 bg-navy/85 p-1.5 transition-transform group-hover:translate-y-0">
        {done ? (
          <button type="button" title="Use as reference" onClick={act(onRef)} className="rounded p-1 text-cream-2 hover:bg-white/10 hover:text-cream">
            <ImagePlus className="size-4" />
          </button>
        ) : null}
        <button type="button" title="Reuse this prompt and references" onClick={act(onReuse)} className="rounded p-1 text-cream-2 hover:bg-white/10 hover:text-cream">
          <Wand2 className="size-4" />
        </button>
        <button type="button" title="Re-run the same setup" onClick={act(onRerun)} className="rounded p-1 text-cream-2 hover:bg-white/10 hover:text-cream">
          <RotateCw className="size-4" />
        </button>
        {canDelete ? (
          <button type="button" title="Delete" onClick={act(onDelete)} className="rounded p-1 text-cream-2 hover:bg-white/10 hover:text-danger">
            <Trash2 className="size-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

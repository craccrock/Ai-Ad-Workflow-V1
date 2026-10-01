"use client";

import { FolderOpen, Loader2, Music, Upload, Video, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { ImageThumb, VideoThumb } from "@/components/ui/thumb";
import { api, type ApiMedia, type Paginated } from "@/lib/client-api";
import type { MediaType } from "@/lib/types";
import { ACCEPT, mediaTypeOf, uploadMedia } from "@/lib/upload";
import { cn } from "@/lib/utils";

/** A selected input asset (uploaded or picked from the library). */
export type MediaRef = { url: string; name: string; mediaId?: string; durationSeconds?: number; width?: number; height?: number };

export function refFromMedia(m: ApiMedia): MediaRef {
  return { url: m.url, name: m.filename, mediaId: m.id, durationSeconds: m.metadata?.duration_seconds, width: m.metadata?.width, height: m.metadata?.height };
}

function LibraryPicker({ type, open, onOpenChange, onPick }: { type: MediaType; open: boolean; onOpenChange: (o: boolean) => void; onPick: (m: ApiMedia) => void }) {
  const [items, setItems] = useState<ApiMedia[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api<Paginated<ApiMedia>>(`/api/media?type=${type}&limit=60`)
      .then((r) => !cancelled && setItems(r.data))
      .catch((e) => toast.error(e.message));
    return () => {
      cancelled = true;
    };
  }, [open, type]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Choose ${type === "audio" ? "audio" : `an ${type}`} from the library`} wide>
        {!items ? (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">{Array.from({ length: 10 }, (_, i) => <div key={i} className="shimmer aspect-square rounded-[6px]" />)}</div>
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-sm text-cream-2">Nothing here yet — upload one instead.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
            {items.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onPick(m);
                  onOpenChange(false);
                }}
                className="group overflow-hidden rounded-[6px] border border-hairline bg-field text-left hover:border-gold"
              >
                <div className="relative flex aspect-square items-center justify-center overflow-hidden bg-navy">
                  {m.type === "image" ? (
                    <ImageThumb src={m.url} alt="" sizes="160px" className="object-cover" />
                  ) : m.type === "video" ? (
                    <VideoThumb src={m.url} className="h-full w-full object-cover" />
                  ) : (
                    <Music className="size-8 text-cream-2" />
                  )}
                </div>
                <div className="truncate px-2 py-1.5 text-[11px] text-cream-2">{m.filename}</div>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Drag-and-drop zone that uploads to Storage (and the library), or picks an existing library asset.
 * `slots` > 1 renders a row of slots (e.g. start + end frame, or multiple references).
 */
export function MediaInput({
  type,
  userId,
  value,
  onChange,
  slots = 1,
  slotLabels,
  label,
  hint,
}: {
  type: MediaType;
  userId: string;
  value: MediaRef[];
  onChange: (refs: MediaRef[]) => void;
  slots?: number;
  slotLabels?: string[];
  label: string;
  /** Small muted line under the label, e.g. limits or usage. */
  hint?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const remaining = slots - value.length;
  // Audio rows stack; images and video tile when there's more than one slot.
  const tiled = slots > 1 && type !== "audio";

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files).filter((f) => mediaTypeOf(f) === type).slice(0, Math.max(0, remaining));
      if (!list.length) {
        toast.error(remaining <= 0 ? `Max ${slots} file(s) for this model` : `Please drop ${type === "audio" ? "an audio file" : `a ${type}`}`);
        return;
      }
      setUploading((n) => n + list.length);
      const added: MediaRef[] = [];
      for (const file of list) {
        try {
          const media = await uploadMedia(file, userId);
          added.push(refFromMedia(media));
          toast.success("Media uploaded", { description: file.name });
        } catch (e) {
          toast.error("Upload failed", { description: e instanceof Error ? e.message : String(e) });
        } finally {
          setUploading((n) => n - 1);
        }
      }
      if (added.length) onChange([...value, ...added].slice(0, slots));
    },
    [onChange, remaining, slots, type, userId, value],
  );

  const Icon = type === "audio" ? Music : type === "video" ? Video : Upload;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-xs font-medium uppercase tracking-[0.08em] text-cream-2">{label}</span>
          {hint ? <div className="mt-0.5 text-[11px] text-muted">{hint}</div> : null}
        </div>
        {remaining > 0 ? (
          <button type="button" onClick={() => setPickerOpen(true)} className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] text-cream-2 hover:text-cream">
            <FolderOpen className="size-3.5" /> From library
          </button>
        ) : null}
      </div>

      <div className={cn("grid gap-2", tiled ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-1")}>
        {value.map((ref, i) => (
          <div key={`${ref.url}-${i}`} className={cn("group relative overflow-hidden rounded-[6px] border border-hairline bg-field", type === "audio" ? "" : slots > 1 ? "aspect-[4/3]" : "h-44")}>
            {type === "image" ? (
              <ImageThumb src={ref.url} alt={ref.name} sizes="(max-width: 640px) 50vw, 240px" className="object-cover" />
            ) : type === "video" ? (
              <VideoThumb src={ref.url} className="h-full w-full object-cover" />
            ) : (
              <div className="flex items-center gap-3 px-3 py-2.5">
                <Music className="size-4 shrink-0 text-gold" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-cream">{ref.name}</div>
                  <audio src={ref.url} controls className="mt-1.5 h-7 w-full" />
                </div>
                {ref.durationSeconds ? <span className="font-mono text-[11px] text-cream-2">{ref.durationSeconds.toFixed(1)}s</span> : null}
              </div>
            )}
            {slotLabels?.[i] && type !== "audio" ? (
              <span className="absolute left-1.5 top-1.5 rounded bg-navy/80 px-1.5 py-0.5 text-[10px] text-cream-2">{slotLabels[i]}</span>
            ) : null}
            <button
              type="button"
              aria-label="Remove"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              className="absolute right-1.5 top-1.5 rounded-full bg-navy/80 p-1 text-cream-2 hover:text-cream"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}

        {remaining > 0 ? (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void handleFiles(e.dataTransfer.files);
            }}
            className={cn(
              "flex flex-col items-center justify-center gap-1.5 rounded-[6px] border border-dashed px-3 text-center transition-colors",
              type === "audio" ? "py-5" : slots > 1 ? "aspect-[4/3]" : "h-28",
              value.length === 0 && tiled ? "col-span-2 aspect-auto py-6 sm:col-span-3" : "",
              dragging ? "border-gold bg-gold/5" : "border-field-border bg-field hover:border-white/25",
            )}
          >
            {uploading > 0 ? <Loader2 className="size-5 animate-spin text-gold" /> : <Icon className="size-5 text-cream-2" />}
            <span className="text-xs text-cream-2">
              {uploading > 0 ? "Uploading…" : value.length === 0 ? `Drop ${slotLabels?.[0]?.toLowerCase() ?? type} or click` : `Add ${slotLabels?.[value.length]?.toLowerCase() ?? "another"}`}
            </span>
            {type === "audio" && uploading === 0 ? <span className="text-[10px] text-muted">mp3 or wav</span> : null}
          </button>
        ) : null}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT[type]}
        multiple={slots > 1}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <LibraryPicker type={type} open={pickerOpen} onOpenChange={setPickerOpen} onPick={(m) => onChange([...value, refFromMedia(m)].slice(0, slots))} />
    </div>
  );
}

"use client";

import { FolderOpen, Loader2, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { LibraryPicker } from "@/components/library/library-picker";
import { ImageThumb } from "@/components/ui/thumb";
import type { ApiMedia } from "@/lib/client-api";
import type { Media } from "@/lib/types";
import { ACCEPT, uploadMedia } from "@/lib/upload";
import { cn } from "@/lib/utils";

/**
 * One slot of a beat's reference box (Pose / Setting, or a subject's base image):
 * shows the chosen image, or lets you pick from the library or upload.
 */
export function RefSlot({
  label,
  hint,
  media,
  userId,
  onChange,
  disabled,
  compact,
}: {
  label: string;
  hint?: string;
  media: Media | null | undefined;
  userId: string;
  onChange: (media: ApiMedia | null) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [picker, setPicker] = useState(false);
  const [uploading, setUploading] = useState(false);

  async function upload(file: File) {
    setUploading(true);
    try {
      onChange(await uploadMedia(file, userId));
    } catch (e) {
      toast.error("Upload failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className={cn("min-w-0", disabled && "opacity-50")}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-cream-2">{label}</span>
        {hint ? <span className="truncate text-[10px] text-muted">{hint}</span> : null}
      </div>
      {media ? (
        <div className={cn("group relative overflow-hidden rounded-[6px] border border-hairline bg-field", compact ? "aspect-[3/4]" : "aspect-square")}>
          <ImageThumb src={media.url} alt={media.filename} sizes="160px" className="object-cover" />
          <div className="absolute inset-x-0 bottom-0 truncate bg-navy/80 px-1.5 py-1 text-[10px] text-cream-2" title={`${media.folder ? `${media.folder} / ` : ""}${media.filename}`}>
            {media.filename}
          </div>
          {!disabled ? (
            <button type="button" aria-label="Remove" onClick={() => onChange(null)} className="absolute right-1 top-1 rounded-full bg-navy/80 p-1 text-cream-2 hover:text-cream">
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      ) : (
        <div
          className={cn(
            "flex flex-col items-center justify-center gap-1 rounded-[6px] border border-dashed border-field-border bg-field text-[11px] text-cream-2",
            compact ? "aspect-[3/4]" : "aspect-square",
          )}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f && !disabled) void upload(f);
          }}
        >
          {uploading ? (
            <Loader2 className="size-4 animate-spin text-gold" />
          ) : (
            <>
              <button type="button" disabled={disabled} onClick={() => setPicker(true)} className="flex items-center gap-1 hover:text-cream">
                <FolderOpen className="size-3.5" /> Library
              </button>
              <button type="button" disabled={disabled} onClick={() => inputRef.current?.click()} className="flex items-center gap-1 hover:text-cream">
                <Upload className="size-3.5" /> Upload
              </button>
            </>
          )}
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT.image}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = "";
        }}
      />
      <LibraryPicker type="image" open={picker} onOpenChange={setPicker} onPick={onChange} title={`Choose a ${label.toLowerCase()} reference`} />
    </div>
  );
}

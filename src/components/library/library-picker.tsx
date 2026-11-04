"use client";

import { Music, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, NativeSelect } from "@/components/ui/input";
import { ImageThumb, VideoThumb } from "@/components/ui/thumb";
import { api, type ApiMedia, type Paginated } from "@/lib/client-api";
import type { MediaType } from "@/lib/types";

export type Folder = { folder: string; count: number };

/** Loads the imported B-roll folders once; shared by the picker and the library page. */
export function useFolders() {
  const [folders, setFolders] = useState<Folder[]>([]);
  useEffect(() => {
    api<{ data: Folder[] }>("/api/media/folders")
      .then((r) => setFolders(r.data))
      .catch(() => setFolders([]));
  }, []);
  return folders;
}

/** Library chooser with a folder filter and search, for reference slots. */
export function LibraryPicker({ type, open, onOpenChange, onPick, title }: { type: MediaType; open: boolean; onOpenChange: (o: boolean) => void; onPick: (m: ApiMedia) => void; title?: string }) {
  const [items, setItems] = useState<ApiMedia[] | null>(null);
  const [folder, setFolder] = useState("");
  const [q, setQ] = useState("");
  const folders = useFolders();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const qs = new URLSearchParams({ type, limit: "100" });
    if (folder) qs.set("folder", folder);
    if (q.trim()) qs.set("q", q.trim());
    const t = setTimeout(() => {
      api<Paginated<ApiMedia>>(`/api/media?${qs}`)
        .then((r) => !cancelled && setItems(r.data))
        .catch((e) => toast.error(e.message));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, type, folder, q]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title ?? `Choose ${type === "audio" ? "audio" : `an ${type}`} from the library`} wide>
        <div className="mb-4 flex flex-wrap gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search filenames and tags…" className="pl-8" autoFocus />
          </div>
          {folders.length ? (
            <NativeSelect value={folder} onChange={(e) => setFolder(e.target.value)} className="w-auto min-w-[200px]">
              <option value="">All folders</option>
              {folders.map((f) => (
                <option key={f.folder} value={f.folder}>
                  {f.folder} ({f.count})
                </option>
              ))}
            </NativeSelect>
          ) : null}
        </div>
        {!items ? (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">{Array.from({ length: 10 }, (_, i) => <div key={i} className="shimmer aspect-square rounded-[6px]" />)}</div>
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-sm text-cream-2">Nothing matches — try another folder or search, or upload instead.</p>
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
                <div className="px-2 py-1.5">
                  <div className="truncate text-[11px] text-cream-2">{m.filename}</div>
                  {m.folder ? <div className="truncate text-[10px] text-muted">{m.folder}</div> : null}
                </div>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

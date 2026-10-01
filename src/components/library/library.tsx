"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { Download, Music, Sparkles, Trash2, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Badge, UserAvatar } from "@/components/ui/misc";
import { Menu, MenuItem } from "@/components/ui/menu";
import { Segmented } from "@/components/ui/segmented";
import { api, downloadFile, type ApiMedia, type Paginated } from "@/lib/client-api";
import { ImageThumb, VideoThumb } from "@/components/ui/thumb";
import { extensionFromUrl, formatBytes } from "@/lib/format";
import type { Profile } from "@/lib/types";
import { ACCEPT, uploadMedia } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { downloadAsWebp } from "@/lib/webp";

type TypeFilter = "all" | "image" | "video" | "audio";
type SourceFilter = "all" | "uploads" | "generated";

export function Library({ profile }: { profile: Profile }) {
  const router = useRouter();
  const [type, setType] = useState<TypeFilter>("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [items, setItems] = useState<ApiMedia[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<ApiMedia | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (t: TypeFilter, s: SourceFilter, p: number) => {
    const qs = new URLSearchParams({ page: String(p), limit: "48" });
    if (t !== "all") qs.set("type", t);
    if (s !== "all") qs.set("source", s);
    try {
      const res = await api<Paginated<ApiMedia>>(`/api/media?${qs}`);
      setItems((prev) => (p === 1 ? res.data : [...prev, ...res.data]));
      setHasMore(res.has_more);
      setPage(p);
    } catch (e) {
      toast.error("Couldn't load the library", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(type, source, 1), 0);
    return () => clearTimeout(t);
  }, [type, source, load]);

  async function upload(files: FileList | File[]) {
    const list = Array.from(files);
    setUploading((n) => n + list.length);
    for (const file of list) {
      try {
        const media = await uploadMedia(file, profile.id);
        setItems((prev) => [{ ...media, user: { id: profile.id, display_name: profile.display_name, avatar_url: profile.avatar_url, is_bot: false } }, ...prev]);
        toast.success("Media uploaded", { description: file.name });
      } catch (e) {
        toast.error("Upload failed", { description: `${file.name}: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  async function remove(m: ApiMedia) {
    try {
      if (m.generation_id) await api(`/api/generate/${m.generation_id}`, { method: "DELETE" });
      else await api(`/api/media/${m.id}`, { method: "DELETE" });
      setItems((prev) => prev.filter((p) => p.id !== m.id));
      setSelected(null);
      toast.success("Deleted");
    } catch (e) {
      toast.error("Delete failed", { description: e instanceof Error ? e.message : String(e) });
    }
  }

  const canDelete = (m: ApiMedia) => profile.role === "admin" || m.user_id === profile.id;

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
      }}
      className={cn("relative min-h-[60vh] rounded-[10px] transition-colors", dragging && "bg-gold/5 outline outline-1 outline-dashed outline-gold")}
    >
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl text-cream sm:text-4xl">Media Library</h1>
          <p className="mt-2 text-sm text-cream-2">Reference images, voiceovers and every generated output — shared across the team.</p>
        </div>
        <Button variant="gold" onClick={() => fileRef.current?.click()} disabled={uploading > 0}>
          <Upload /> {uploading > 0 ? `Uploading ${uploading}…` : "Upload"}
        </Button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={[ACCEPT.image, ACCEPT.video, ACCEPT.audio].join(",")}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void upload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-4">
        <Segmented<TypeFilter>
          aria-label="Type"
          value={type}
          onChange={(v) => {
            setLoading(true);
            setType(v);
          }}
          options={[
            { value: "all", label: "All" },
            { value: "image", label: "Images" },
            { value: "video", label: "Video" },
            { value: "audio", label: "Audio" },
          ]}
        />
        <Segmented<SourceFilter>
          aria-label="Source"
          value={source}
          onChange={(v) => {
            setLoading(true);
            setSource(v);
          }}
          options={[
            { value: "all", label: "Everything" },
            { value: "uploads", label: "Uploads" },
            { value: "generated", label: "Generated" },
          ]}
        />
      </div>

      {loading && items.length === 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="shimmer aspect-square rounded-[8px]" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-[8px] border border-dashed border-hairline px-6 py-20 text-center">
          <p className="font-serif text-xl text-cream">Nothing here yet</p>
          <p className="mt-2 text-sm text-cream-2">Drop images, video or audio anywhere on this page.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          {items.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setSelected(m)}
              className="group overflow-hidden rounded-[8px] border border-hairline bg-surface text-left transition-colors hover:border-white/20 hover:bg-elevated"
            >
              <div className="relative flex aspect-square items-center justify-center overflow-hidden bg-[#18223d]">
                {m.type === "image" ? (
                  <ImageThumb src={m.url} alt="" sizes="(max-width: 640px) 50vw, 220px" className="object-cover transition-transform group-hover:scale-[1.02]" />
                ) : m.type === "video" ? (
                  <VideoThumb src={m.url} className="h-full w-full object-cover" />
                ) : (
                  <Music className="size-8 text-cream-2" />
                )}
                {m.generation_id ? (
                  <Badge className="absolute left-1.5 top-1.5 bg-navy/80">
                    <Sparkles className="size-2.5" /> Generated
                  </Badge>
                ) : null}
                {m.metadata?.duration_seconds ? (
                  <span className="absolute bottom-1.5 right-1.5 rounded bg-navy/80 px-1.5 font-mono text-[10px] text-cream-2">{m.metadata.duration_seconds.toFixed(1)}s</span>
                ) : null}
              </div>
              <div className="truncate px-2.5 py-2 text-xs text-cream-2">{m.filename}</div>
            </button>
          ))}
        </div>
      )}

      {hasMore ? (
        <div className="mt-8 flex justify-center">
          <Button variant="underline" onClick={() => {
              setLoading(true);
              void load(type, source, page + 1);
            }} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}

      <Dialog open={Boolean(selected)} onOpenChange={(o) => !o && setSelected(null)}>
        {selected ? (
          <DialogContent title={selected.filename} wide>
            <div className="grid gap-6 md:grid-cols-[1fr_260px]">
              <div className="flex items-center justify-center rounded-[6px] bg-[#18223d]">
                {selected.type === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={selected.url} alt={selected.filename} className="max-h-[65vh] w-full object-contain" />
                ) : selected.type === "video" ? (
                  <video src={selected.url} controls autoPlay playsInline className="max-h-[65vh] w-full object-contain" />
                ) : (
                  <div className="w-full p-8">
                    <Music className="mx-auto mb-6 size-10 text-gold" />
                    <audio src={selected.url} controls className="w-full" />
                  </div>
                )}
              </div>
              <div className="space-y-5">
                <dl className="space-y-2 text-xs">
                  {[
                    ["Type", selected.type],
                    ["Size", formatBytes(selected.file_size_bytes)],
                    ...(selected.metadata?.width ? [["Dimensions", `${selected.metadata.width} × ${selected.metadata.height}`]] : []),
                    ...(selected.metadata?.duration_seconds ? [["Duration", `${selected.metadata.duration_seconds.toFixed(1)}s`]] : []),
                    ["Added", formatDistanceToNowStrict(new Date(selected.created_at), { addSuffix: true })],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3 border-b border-hairline pb-2">
                      <dt className="text-muted">{k}</dt>
                      <dd className="font-mono text-cream-2">{v}</dd>
                    </div>
                  ))}
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-muted">By</dt>
                    <dd className="flex items-center gap-1.5 text-cream-2">
                      <UserAvatar name={selected.user?.display_name ?? "?"} bot={selected.user?.is_bot} size={16} />
                      {selected.user?.display_name ?? "Unknown"}
                    </dd>
                  </div>
                </dl>
                <div className="flex flex-col gap-2">
                  {selected ? (
                    <Button variant="gold" onClick={() => router.push(`/?use=${selected.id}`)}>
                      <Sparkles /> Use in generation
                    </Button>
                  ) : null}
                  <DownloadButton media={selected} />
                  {canDelete(selected) ? (
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (window.confirm(selected.generation_id ? "Delete this generated output and its gallery entry?" : "Delete this file?")) void remove(selected);
                      }}
                    >
                      <Trash2 /> Delete
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}

/** Images can be saved as WebP as well as the original file. */
function DownloadButton({ media }: { media: ApiMedia }) {
  const name = `${media.filename.replace(/\.[^.]+$/, "")}.${extensionFromUrl(media.url, media.type)}`;
  const original = () => downloadFile(media.url, name);

  if (media.type !== "image") {
    return (
      <Button variant="outline" onClick={original}>
        <Download /> Download
      </Button>
    );
  }

  const webp = async () => {
    const toastId = toast.loading("Converting to WebP…");
    try {
      await downloadAsWebp(media.url, name);
      toast.success("Downloaded as WebP", { id: toastId });
    } catch (e) {
      toast.error("Couldn't convert to WebP", { id: toastId, description: `${e instanceof Error ? e.message : String(e)} — downloading the original instead.` });
      void original();
    }
  };

  return (
    <Menu
      trigger={({ onClick }) => (
        <Button variant="outline" onClick={onClick}>
          <Download /> Download
        </Button>
      )}
    >
      {(close) => (
        <>
          <MenuItem onClick={() => { close(); void original(); }} hint="Exactly as generated">
            Original file
          </MenuItem>
          <MenuItem onClick={() => { close(); void webp(); }} hint="Much smaller, for web pages">
            WebP
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

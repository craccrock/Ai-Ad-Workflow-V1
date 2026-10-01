"use client";

import { Download, Trash2, TriangleAlert, X } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Menu, MenuItem } from "@/components/ui/menu";
import { models } from "@/config/models.config";
import { api, type ApiGeneration, type Paginated } from "@/lib/client-api";
import { describeFailure, recentProviderTrouble, retriesOf, type TypicalDurations } from "@/lib/job-status";
import type { Profile } from "@/lib/types";
import { downloadZip } from "@/lib/zip";
import { ResultCard } from "./result-card";

export type GalleryHandle = { prepend: (jobs: ApiGeneration[]) => void };

type Filters = { model: string; media_type: string; user_id: string; from: string; to: string; sort: string };
const EMPTY: Filters = { model: "", media_type: "", user_id: "", from: "", to: "", sort: "newest" };
const POLL_MS = 3000;
const PAGE = 24;

const isInFlight = (g: ApiGeneration) => g.status === "queued" || g.status === "processing";

export const Gallery = forwardRef<
  GalleryHandle,
  {
    currentUser: Profile;
    team: Pick<Profile, "id" | "display_name">[];
    /** How long each model usually takes, for the in-progress estimate on cards. */
    typicalDurations?: TypicalDurations;
    /** Days a generated file is kept, for the "deletes soon" countdown. */
    retentionDays?: number | null;
    onRerun: (g: ApiGeneration) => void;
    onUseSettings: (g: ApiGeneration) => void;
  }
>(function Gallery({ currentUser, team, typicalDurations, retentionDays, onRerun, onUseSettings }, ref) {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [items, setItems] = useState<ApiGeneration[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const lastClickedRef = useRef<string | null>(null);
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const selected = new Set(selectedIds);
  const selectedItems = items.filter((i) => selected.has(i.id));
  const canModifyItem = (g: ApiGeneration) => currentUser.role === "admin" || g.user_id === currentUser.id;

  /** Shift-click extends the selection from the previous click, like a file browser. */
  function toggleSelect(id: string, { shiftKey }: { shiftKey: boolean }) {
    const anchor = lastClickedRef.current;
    lastClickedRef.current = id;
    setSelectedIds((prev) => {
      if (shiftKey && anchor) {
        const from = items.findIndex((i) => i.id === anchor);
        const to = items.findIndex((i) => i.id === id);
        if (from !== -1 && to !== -1) {
          const range = items.slice(Math.min(from, to), Math.max(from, to) + 1).map((i) => i.id);
          return Array.from(new Set([...prev, ...range]));
        }
      }
      return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
    });
  }

  async function downloadSelected(webp = false) {
    const ready = selectedItems.filter((g) => g.status === "completed" && g.result_url);
    if (!ready.length) return void toast.error("Nothing to download", { description: "Only finished generations can be downloaded." });
    setBulkBusy(true);
    const toastId = toast.loading(`Preparing ${ready.length} file(s)…`);
    try {
      await downloadZip(
        ready.map((g) => ({ url: g.result_url!, mediaType: g.media_type, model: g.model_display_name, prompt: g.prompt, createdAt: g.created_at })),
        `madaket-${new Date().toISOString().slice(0, 10)}-${ready.length}-files.zip`,
        (done, total) => toast.loading(`${webp ? "Converting" : "Downloading"} ${done} of ${total}…`, { id: toastId }),
        { webp },
      );
      toast.success(`Downloaded ${ready.length} file(s)`, { id: toastId });
      setSelectedIds([]);
    } catch (e) {
      toast.error("Download failed", { id: toastId, description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBulkBusy(false);
    }
  }

  async function deleteSelected() {
    const mine = selectedItems.filter(canModifyItem);
    const skipped = selectedItems.length - mine.length;
    if (!mine.length) return void toast.error("You can only delete your own generations");
    if (!window.confirm(`Delete ${mine.length} generation(s)? This also removes the files from the library. This can't be undone.`)) return;

    setBulkBusy(true);
    const toastId = toast.loading(`Deleting ${mine.length}…`);
    const deleted: string[] = [];
    let failed = 0;
    for (const g of mine) {
      try {
        await api(`/api/generate/${g.id}`, { method: "DELETE" });
        deleted.push(g.id);
      } catch {
        failed += 1;
      }
      toast.loading(`Deleting ${deleted.length + failed} of ${mine.length}…`, { id: toastId });
    }
    setItems((prev) => prev.filter((p) => !deleted.includes(p.id)));
    setTotal((t) => t - deleted.length);
    setSelectedIds([]);
    setBulkBusy(false);
    const notes = [failed ? `${failed} failed` : "", skipped ? `${skipped} skipped (not yours)` : ""].filter(Boolean).join(", ");
    toast[failed ? "error" : "success"](`Deleted ${deleted.length}`, { id: toastId, description: notes || undefined });
  }

  const load = useCallback(async (f: Filters, p: number) => {
    setLoading(true);
    const qs = new URLSearchParams({ page: String(p), limit: String(PAGE), sort: f.sort });
    for (const k of ["model", "media_type", "user_id", "from", "to"] as const) if (f[k]) qs.set(k, f[k]);
    try {
      const res = await api<Paginated<ApiGeneration>>(`/api/generations?${qs}`);
      setItems((prev) => (p === 1 ? res.data : [...prev, ...res.data.filter((d) => !prev.some((x) => x.id === d.id))]));
      setHasMore(res.has_more);
      setTotal(res.total);
      setPage(p);
    } catch (e) {
      toast.error("Couldn't load generations", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred a tick so the loading state isn't set synchronously inside the effect.
    const t = setTimeout(() => void load(filters, 1), 0);
    return () => clearTimeout(t);
  }, [filters, load]);

  useImperativeHandle(ref, () => ({
    prepend: (jobs) => {
      setItems((prev) => [...jobs, ...prev.filter((p) => !jobs.some((j) => j.id === p.id))]);
      setTotal((t) => t + jobs.length);
    },
  }));

  // Unified status polling — one endpoint regardless of provider.
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      const inflight = itemsRef.current.filter(isInFlight).slice(0, 12);
      await Promise.all(
        inflight.map(async (g) => {
          try {
            const s = await api<{ status: ApiGeneration["status"]; retries?: number }>(`/api/generate/${g.id}/status`);
            // Refetch the full row when the status moves or Kie was retried (so the card can say so).
            if (s.status === g.status && (s.retries ?? 0) === retriesOf(g).length) return;
            const full = await api<ApiGeneration>(`/api/generate/${g.id}`);
            if (stopped) return;
            setItems((prev) => prev.map((p) => (p.id === g.id ? full : p)));
            if (full.user_id === currentUser.id) {
              if (full.status === "completed") toast.success("Generation complete", { description: full.model_display_name });
              if (full.status === "failed") {
                const { title, advice } = describeFailure(full);
                toast.error(`${full.model_display_name}: ${title}`, { description: advice, duration: 15_000 });
              }
            }
          } catch {
            /* transient — try again next tick */
          }
        }),
      );
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    let timer = setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [currentUser.id]);

  async function remove(g: ApiGeneration) {
    try {
      await api(`/api/generate/${g.id}`, { method: "DELETE" });
      setItems((prev) => prev.filter((p) => p.id !== g.id));
      setTotal((t) => t - 1);
      toast.success("Deleted");
    } catch (e) {
      toast.error("Delete failed", { description: e instanceof Error ? e.message : String(e) });
    }
  }

  // A new filter reloads the list, so any selection is cleared with it.
  const changeFilters = (update: (f: Filters) => Filters) => {
    setSelectedIds([]);
    setFilters(update);
  };
  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => changeFilters((f) => ({ ...f, [k]: e.target.value }));
  const filtered = Object.entries(filters).some(([k, v]) => k !== "sort" && v);

  return (
    <section aria-label="Results" className="min-w-0">
      <ProviderTroubleNotice items={items} />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-serif text-2xl text-cream">Generations</h2>
          <p className="mt-0.5 font-mono text-[11px] text-muted">{total} total</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect aria-label="Filter by model" value={filters.model} onChange={set("model")} className="h-8 w-auto text-xs">
            <option value="">All models</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.tier ? `${m.name} ${m.tier}` : m.name}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect aria-label="Filter by type" value={filters.media_type} onChange={set("media_type")} className="h-8 w-auto text-xs">
            <option value="">All types</option>
            <option value="video">Video</option>
            <option value="image">Image</option>
            <option value="audio">Audio</option>
          </NativeSelect>
          <NativeSelect aria-label="Filter by user" value={filters.user_id} onChange={set("user_id")} className="h-8 w-auto text-xs">
            <option value="">Everyone</option>
            {team.map((u) => (
              <option key={u.id} value={u.id}>
                {u.id === currentUser.id ? "Me" : u.display_name}
              </option>
            ))}
          </NativeSelect>
          <Input aria-label="From date" type="date" value={filters.from} onChange={set("from")} className="h-8 w-auto text-xs [color-scheme:dark]" />
          <Input aria-label="To date" type="date" value={filters.to} onChange={set("to")} className="h-8 w-auto text-xs [color-scheme:dark]" />
          <NativeSelect aria-label="Sort" value={filters.sort} onChange={set("sort")} className="h-8 w-auto text-xs">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="cost">Highest cost</option>
          </NativeSelect>
          {filtered ? (
            <Button variant="ghost" size="sm" onClick={() => changeFilters(() => EMPTY)}>
              Clear
            </Button>
          ) : null}
        </div>
      </div>

      {selectedIds.length > 0 ? (
        <div className="sticky top-[72px] z-20 mb-4 flex flex-wrap items-center gap-2 rounded-[8px] border border-gold/40 bg-elevated px-3 py-2 shadow-lg">
          <span className="font-mono text-xs text-cream">{selectedIds.length} selected</span>
          <Button variant="ghost" size="sm" disabled={bulkBusy} onClick={() => setSelectedIds(items.map((i) => i.id))}>
            Select all {items.length}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Menu align="right" trigger={({ onClick }) => (
              <Button variant="gold" size="sm" disabled={bulkBusy} onClick={onClick}>
                <Download /> Download zip
              </Button>
            )}>
              {(close) => (
                <>
                  <MenuItem onClick={() => { close(); void downloadSelected(false); }} hint="Exactly as generated">
                    Original files
                  </MenuItem>
                  <MenuItem onClick={() => { close(); void downloadSelected(true); }} hint="Images converted; much smaller for web">
                    Images as WebP
                  </MenuItem>
                </>
              )}
            </Menu>
            <Button variant="danger" size="sm" disabled={bulkBusy} onClick={deleteSelected}>
              <Trash2 /> Delete
            </Button>
            <Button variant="ghost" size="icon" aria-label="Clear selection" disabled={bulkBusy} onClick={() => setSelectedIds([])}>
              <X />
            </Button>
          </div>
        </div>
      ) : null}

      {loading && items.length === 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="overflow-hidden rounded-[8px] border border-hairline bg-surface">
              <div className="shimmer aspect-[4/5]" />
              <div className="space-y-2 p-3.5">
                <div className="shimmer h-4 w-1/2 rounded" />
                <div className="shimmer h-3 w-4/5 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-[8px] border border-dashed border-hairline px-6 py-20 text-center">
          <p className="font-serif text-xl text-cream">{filtered ? "Nothing matches these filters" : "No generations yet"}</p>
          <p className="mt-2 text-sm text-cream-2">{filtered ? "Try clearing a filter." : "Pick a model, write a prompt, and press ⌘ Enter."}</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
          {items.map((g) => (
            <ResultCard
              key={g.id}
              gen={g}
              typicalDurations={typicalDurations}
              retentionDays={retentionDays}
              canModify={canModifyItem(g)}
              selected={selected.has(g.id)}
              anySelected={selectedIds.length > 0}
              onToggleSelect={toggleSelect}
              onRerun={onRerun}
              onUseSettings={onUseSettings}
              onDelete={remove}
            />
          ))}
        </div>
      )}

      {hasMore ? (
        <div className="mt-8 flex justify-center">
          <Button variant="underline" onClick={() => load(filters, page + 1)} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </section>
  );
});

/** Heads-up when Kie is failing or retrying several recent jobs, so editors know it's not their settings. */
function ProviderTroubleNotice({ items }: { items: ApiGeneration[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const trouble = recentProviderTrouble(items, now);
  if (!trouble) return null;
  return (
    <div role="status" className="mb-4 flex items-start gap-2.5 rounded-[8px] border border-gold/40 bg-gold/10 px-3.5 py-2.5 text-[13px] text-cream-2">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-gold" />
      <p>
        <span className="text-cream">{trouble.provider} is having trouble right now.</span> {trouble.count} recent jobs hit errors on their side. Jobs are retried
        automatically; if yours still fails, try again in a few minutes. Failed jobs aren&apos;t charged.
      </p>
    </div>
  );
}

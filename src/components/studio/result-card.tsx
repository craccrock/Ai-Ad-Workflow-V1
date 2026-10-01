"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { Check, Clock, CloudDownload, Copy, Download, FileX, LifeBuoy, Lock, Music, Repeat, RotateCw, SlidersHorizontal, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Menu, MenuItem } from "@/components/ui/menu";
import { ImageThumb, VideoThumb } from "@/components/ui/thumb";
import { Badge, UserAvatar } from "@/components/ui/misc";
import { providerLabels } from "@/config/models.config";
import { downloadFile, type ApiGeneration } from "@/lib/client-api";
import { extensionFromUrl } from "@/lib/format";
import { awaitingCopy, describeFailure, describeInFlight, expiryInfo, retriesOf, type TypicalDurations } from "@/lib/job-status";
import { cn, formatUsd } from "@/lib/utils";
import { downloadAsWebp } from "@/lib/webp";

/** Current time, refreshed every `intervalMs` so relative labels don't go stale. */
function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function InFlightStatus({ gen, typicalDurations }: { gen: ApiGeneration; typicalDurations?: TypicalDurations }) {
  const now = useNow(1000);
  const { label, progress, expected, notes } = describeInFlight(gen, now, typicalDurations);
  const s = Math.max(0, Math.floor((now - new Date(gen.created_at).getTime()) / 1000));
  return (
    <div className="shimmer flex h-full w-full flex-col items-center justify-center gap-2 px-5 text-center text-cream-2">
      <span className="text-xs uppercase tracking-[0.14em]">{label}</span>
      <span className="font-mono text-[11px] text-muted">{s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`}</span>
      {progress != null ? (
        <div className="h-1 w-32 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label="Estimated progress" aria-valuenow={Math.round(progress * 100)}>
          <div className="h-full rounded-full bg-gold/70 transition-[width] duration-1000 ease-linear" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      ) : null}
      {expected ? <p className="text-[11px] text-muted">{expected}</p> : null}
      {notes.map((note) => (
        <p key={note} className="max-w-[26ch] text-[11px] leading-snug text-muted">
          {note}
        </p>
      ))}
    </div>
  );
}

/** The file was cleaned up after its retention window; everything else about the job is still here. */
function RemovedStatus({ gen }: { gen: ApiGeneration }) {
  const days = (gen.result_metadata?.retention_days as number | undefined) ?? 7;
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
      <FileX className="size-5 text-muted" />
      <p className="text-[13px] font-medium text-cream">File removed after {days} days</p>
      <p className="text-xs leading-snug text-cream-2">The prompt and settings are kept — press ↻ to make it again.</p>
    </div>
  );
}

function FailedStatus({ gen }: { gen: ApiGeneration }) {
  const { title, advice, detail } = describeFailure(gen);
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
      <TriangleAlert className="size-5 text-danger" />
      <p className="text-[13px] font-medium text-cream">{title}</p>
      <p className="text-xs leading-snug text-cream-2">{advice}</p>
      <p className="line-clamp-3 font-mono text-[10px] leading-snug text-muted" title={detail}>
        {detail}
      </p>
    </div>
  );
}

function RelativeTime({ iso }: { iso: string }) {
  useNow(30_000);
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} className="whitespace-nowrap" suppressHydrationWarning>
      {formatDistanceToNowStrict(new Date(iso), { addSuffix: true })}
    </time>
  );
}

/** Every output file of a job: the main result plus extra takes (Suno returns two). */
function takesOf(gen: ApiGeneration): { url: string; title?: string; seconds?: number }[] {
  if (!gen.result_url) return [];
  const meta = (gen.result_metadata ?? {}) as { additional_files?: string[]; provider?: { tracks?: { title?: string; duration_seconds?: number }[] } };
  const tracks = meta.provider?.tracks ?? [];
  return [gen.result_url, ...(meta.additional_files ?? [])].map((url, i) => ({ url, title: tracks[i]?.title, seconds: tracks[i]?.duration_seconds }));
}

const clock = (s?: number) => (s == null ? null : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

function AudioTakes({ gen, autoPlay = false }: { gen: ApiGeneration; autoPlay?: boolean }) {
  const takes = takesOf(gen);
  return (
    <div className="space-y-4 rounded-[6px] bg-[#18223d] p-5">
      {takes.map((t, i) => (
        <div key={t.url} className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3 text-xs text-cream-2">
            <span className="truncate">{takes.length > 1 ? `Take ${i + 1}` : (t.title ?? "Audio")}{takes.length > 1 && t.title ? ` · ${t.title}` : ""}</span>
            <span className="font-mono text-muted">{clock(t.seconds)}</span>
          </div>
          {/* Players load metadata only; audio downloads when someone presses play. */}
          <audio src={t.url} controls preload="metadata" autoPlay={autoPlay && i === 0} className="w-full" />
        </div>
      ))}
    </div>
  );
}

export function ResultCard({
  gen,
  typicalDurations,
  retentionDays,
  canModify,
  selected,
  anySelected,
  onToggleSelect,
  onRerun,
  onUseSettings,
  onDelete,
}: {
  gen: ApiGeneration;
  typicalDurations?: TypicalDurations;
  /** Days a generated file is kept before the cleanup deletes it (null = kept forever). */
  retentionDays?: number | null;
  canModify: boolean;
  selected: boolean;
  /** While a selection is active, clicking the preview selects instead of opening it. */
  anySelected: boolean;
  onToggleSelect: (id: string, opts: { shiftKey: boolean }) => void;
  onRerun: (g: ApiGeneration) => void;
  onUseSettings: (g: ApiGeneration) => void;
  onDelete: (g: ApiGeneration) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [viewer, setViewer] = useState(false);
  const inFlight = gen.status === "queued" || gen.status === "processing";
  const retries = retriesOf(gen);
  const expiry = expiryInfo(gen, useNow(60_000), retentionDays);
  // The file hasn't reached our storage yet; showing the provider's copy gives a half-loaded image.
  const copying = awaitingCopy(gen);
  const cost = gen.cost_usd ?? gen.estimated_cost_usd;

  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(false), 3000);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  const audioTitle = takesOf(gen)[0]?.title ?? (gen.params as { settings?: { title?: string } }).settings?.title;
  const takeCount = takesOf(gen).length;

  const preview = (large = false) =>
    gen.media_type === "audio" ? (
      large ? (
        <AudioTakes gen={gen} autoPlay />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-5 pb-12 text-center">
          <Music className="size-9 text-gold" />
          {audioTitle ? <span className="line-clamp-2 font-serif text-base text-cream">{audioTitle}</span> : null}
          <span className="font-mono text-[11px] text-muted">
            {[clock(gen.duration_seconds != null ? Number(gen.duration_seconds) : undefined), takeCount > 1 ? `${takeCount} takes` : null].filter(Boolean).join(" · ")}
          </span>
        </div>
      )
    ) : gen.media_type === "video" ? (
      large ? (
        <video src={gen.result_url!} controls autoPlay playsInline className="max-h-[62vh] w-full rounded-[6px] bg-black object-contain" />
      ) : (
        <VideoThumb src={gen.result_url!} className="h-full w-full object-contain" />
      )
    ) : large ? (
      // Full size only once someone opens it.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={gen.result_url!} alt={gen.prompt ?? ""} className="max-h-[62vh] w-full rounded-[6px] object-contain" />
    ) : (
      <ImageThumb src={gen.result_url!} alt={gen.prompt ?? ""} sizes="(max-width: 640px) 100vw, 320px" className="object-contain" />
    );

  return (
    <article
      className={cn(
        "group flex flex-col overflow-hidden rounded-[8px] border bg-surface transition-colors hover:bg-elevated",
        selected ? "border-gold/70 shadow-[0_0_0_1px_var(--gold)]" : "border-hairline",
      )}
    >
      <div className="relative aspect-[4/5] bg-[#18223d]">
        {copying ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
            <CloudDownload className="size-5 text-cream-2" />
            <p className="text-[13px] font-medium text-cream">Finishing up</p>
            <p className="text-xs leading-snug text-cream-2">
              {providerLabels[gen.provider] ?? gen.provider} is being slow to hand the file over. It&apos;ll appear here shortly — the job is done and paid for.
            </p>
          </div>
        ) : gen.status === "completed" && gen.result_url ? (
          <button
            type="button"
            className="h-full w-full"
            onClick={(e) => (anySelected ? onToggleSelect(gen.id, { shiftKey: e.shiftKey }) : setViewer(true))}
            aria-label={anySelected ? "Select" : "Open preview"}
          >
            {preview()}
          </button>
        ) : null}
        {!copying && gen.status === "completed" && gen.result_url && gen.media_type === "audio" ? (
          <audio src={gen.result_url} controls preload="none" className="absolute inset-x-2 bottom-2 z-10 h-9 w-[calc(100%-1rem)]" aria-label="Play take 1" />
        ) : null}
        {gen.status === "completed" && gen.result_url ? null : inFlight ? (
          <InFlightStatus gen={gen} typicalDurations={typicalDurations} />
        ) : expiry.deleted ? (
          <RemovedStatus gen={gen} />
        ) : (
          <FailedStatus gen={gen} />
        )}
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={`Select ${gen.model_display_name} generation`}
          onClick={(e) => onToggleSelect(gen.id, { shiftKey: e.shiftKey })}
          className={cn(
            "absolute right-2 top-2 z-10 flex size-6 items-center justify-center rounded-[5px] border transition-opacity",
            selected
              ? "border-gold bg-gold text-navy opacity-100"
              : "border-white/40 bg-navy/70 text-transparent opacity-0 hover:border-gold focus-visible:opacity-100 group-hover:opacity-100",
          )}
        >
          <Check className="size-3.5" strokeWidth={3} />
        </button>

        <div className="pointer-events-none absolute left-2 top-2 flex gap-1.5">
          {gen.source === "api" ? <Badge className="bg-navy/80">API</Badge> : null}
          {retries.length ? (
            <Badge className="pointer-events-auto bg-navy/80" title={`Retried automatically after: ${retries.map((r) => r.error).join(" · ")}`}>
              <RotateCw className="size-2.5" /> Retried
            </Badge>
          ) : null}
          {gen.fallback_reason ? (
            <Badge className="pointer-events-auto bg-navy/80" title={`Ran on backup provider. ${gen.fallback_reason}`}>
              <LifeBuoy className="size-2.5" /> Backup
            </Badge>
          ) : null}
          {!gen.is_shared ? (
            <Badge className="bg-navy/80">
              <Lock className="size-2.5" /> Private
            </Badge>
          ) : null}
          {expiry.notice ? (
            <Badge className="pointer-events-auto bg-gold/20 text-gold" title="Generated files are deleted after a week. Download it if you want to keep it.">
              <Clock className="size-2.5" /> {expiry.notice}
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-serif text-[15px] text-cream">{gen.model_display_name}</span>
          <span className={cn("shrink-0 font-mono text-xs", gen.status === "failed" ? "text-muted line-through" : "text-gold")}>
            {inFlight ? "~" : ""}
            {formatUsd(cost != null ? Number(cost) : null)}
          </span>
        </div>

        {gen.prompt ? (
          <button type="button" onClick={() => setExpanded((v) => !v)} className={cn("text-left text-[13px] leading-snug text-cream-2", !expanded && "line-clamp-2")}>
            {gen.prompt}
          </button>
        ) : null}

        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
          <UserAvatar name={gen.user?.display_name ?? "?"} url={gen.user?.avatar_url} bot={gen.user?.is_bot} size={18} />
          <span className="truncate">{gen.user?.display_name ?? "Unknown"}</span>
          <span>·</span>
          <RelativeTime iso={gen.created_at} />
        </div>

        <div className="mt-auto -mx-1.5 flex items-center border-t border-hairline pt-1.5">
          <div className="flex w-full items-center opacity-80 transition-opacity group-hover:opacity-100">
            {gen.result_url ? <DownloadButton gen={gen} /> : null}
            {gen.prompt ? (
              <IconButton
                label="Copy prompt"
                onClick={() => {
                  void navigator.clipboard.writeText(gen.prompt!);
                  toast.success("Prompt copied");
                }}
              >
                <Copy />
              </IconButton>
            ) : null}
            <IconButton label="Re-run with same settings" onClick={() => onRerun(gen)}>
              <Repeat />
            </IconButton>
            <IconButton label="Load settings into form" onClick={() => onUseSettings(gen)}>
              <SlidersHorizontal />
            </IconButton>
            {canModify ? (
              <span className="ml-auto">
              {confirmDelete ? (
                <button type="button" onClick={() => onDelete(gen)} className="ml-1 rounded px-1.5 py-0.5 text-[11px] text-danger hover:bg-danger/10">
                  Delete?
                </button>
              ) : (
                <IconButton label="Delete" onClick={() => setConfirmDelete(true)}>
                  <Trash2 />
                </IconButton>
              )}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {gen.result_url ? (
        <Dialog open={viewer} onOpenChange={setViewer}>
          <DialogContent title={gen.model_display_name} wide>
            {/* Media first so it's never pushed off screen by a long prompt. */}
            {viewer ? preview(true) : null}
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-muted">
              {gen.resolution ? <span>{gen.resolution}</span> : null}
              {gen.aspect_ratio ? <span>{gen.aspect_ratio}</span> : null}
              {gen.duration_seconds ? <span>{Number(gen.duration_seconds)}s</span> : null}
              <span>{formatUsd(cost != null ? Number(cost) : null)}</span>
              <span>{providerLabels[gen.provider]}</span>
            </div>
            {gen.prompt ? <ViewerPrompt prompt={gen.prompt} /> : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </article>
  );
}

/** Prompt under the media: two lines by default, expandable, copyable. */
function ViewerPrompt({ prompt }: { prompt: string }) {
  const [open, setOpen] = useState(false);
  const long = prompt.length > 180;
  return (
    <div className="mt-4 border-t border-hairline pt-3">
      <p className={cn("whitespace-pre-wrap text-sm leading-relaxed text-cream-2", !open && "line-clamp-2")}>{prompt}</p>
      <div className="mt-2 flex items-center gap-4 text-xs">
        {long ? (
          <button type="button" onClick={() => setOpen((v) => !v)} className="border-b border-cream/30 pb-0.5 text-cream-2 hover:border-cream hover:text-cream">
            {open ? "Hide full prompt" : "Show full prompt"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(prompt);
            toast.success("Prompt copied");
          }}
          className="flex items-center gap-1 text-cream-2 hover:text-cream"
        >
          <Copy className="size-3" /> Copy prompt
        </button>
      </div>
    </div>
  );
}

/** Images offer WebP as well as the original; everything else downloads straight. */
function DownloadButton({ gen }: { gen: ApiGeneration }) {
  const ext = extensionFromUrl(gen.result_url!, gen.media_type);
  const name = `madaket-${gen.model}-${gen.id.slice(0, 8)}.${ext}`;
  const original = () => downloadFile(gen.result_url!, name);

  const takes = takesOf(gen);
  if (gen.media_type !== "image" && takes.length > 1) {
    return (
      <Menu
        trigger={({ onClick }) => (
          <IconButton label="Download" onClick={onClick}>
            <Download />
          </IconButton>
        )}
      >
        {(close) =>
          takes.map((t, i) => (
            <MenuItem key={t.url} onClick={() => { close(); void downloadFile(t.url, name.replace(`.${ext}`, `-take${i + 1}.${ext}`)); }} hint={clock(t.seconds) ?? undefined}>
              Take {i + 1}
            </MenuItem>
          ))
        }
      </Menu>
    );
  }

  if (gen.media_type !== "image") {
    return (
      <IconButton label="Download" onClick={original}>
        <Download />
      </IconButton>
    );
  }

  const webp = async () => {
    const toastId = toast.loading("Converting to WebP…");
    try {
      await downloadAsWebp(gen.result_url!, name);
      toast.success("Downloaded as WebP", { id: toastId });
    } catch (e) {
      toast.error("Couldn't convert to WebP", { id: toastId, description: `${e instanceof Error ? e.message : String(e)} — downloading the original instead.` });
      void original();
    }
  };

  return (
    <Menu
      trigger={({ onClick }) => (
        <IconButton label="Download" onClick={onClick}>
          <Download />
        </IconButton>
      )}
    >
      {(close) => (
        <>
          <MenuItem onClick={() => { close(); void original(); }} hint="Exactly as generated">
            Original .{ext}
          </MenuItem>
          <MenuItem onClick={() => { close(); void webp(); }} hint="Much smaller, for web pages">
            WebP
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className="rounded p-1.5 text-cream-2 hover:bg-white/5 hover:text-cream [&_svg]:size-3.5">
      {children}
    </button>
  );
}

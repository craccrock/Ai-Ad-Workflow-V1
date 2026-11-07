"use client";

import { Check, Clapperboard, Loader2, Play, RotateCw, Sparkles, Square, Wand2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { getModel, models } from "@/config/models.config";
import { api, type ApiGeneration, type ApiMedia } from "@/lib/client-api";
import { estimateCost } from "@/lib/generation-params";
import type { Beat, BoardWithBeats, Media, Profile, Subject } from "@/lib/types";
import { cn, formatUsd } from "@/lib/utils";
import { BeatCard, fetchGeneration, videoModels, type BeatPatch } from "./beat-card";
import { SubjectPicker } from "./subject-picker";

const POLL_MS = 3000;
const SAVE_DEBOUNCE_MS = 800;
const isInFlight = (g?: ApiGeneration | null) => g?.status === "queued" || g?.status === "processing";

/** Beats as the PUT endpoint wants them (new beats have a temporary client id). */
function toPayload(beats: Beat[]) {
  return beats.map((b) => ({
    id: b.id.startsWith("new-") ? undefined : b.id,
    role: b.role,
    vo: b.vo,
    shot_type: b.shot_type,
    style: b.style,
    image_prompt: b.image_prompt,
    video_prompt: b.video_prompt,
    negative_prompt: b.negative_prompt,
    reference_plan: b.reference_plan,
    use_subject_lock: b.use_subject_lock,
    pose_media_id: b.pose_media_id,
    setting_media_id: b.setting_media_id,
    extra_media_ids: b.extra_media_ids ?? [],
    video_model: b.video_model ?? null,
    video_duration: b.video_duration ?? null,
    video_resolution: b.video_resolution ?? null,
  }));
}

function newBeat(boardId: string, from?: Partial<Beat>): Beat {
  return {
    id: `new-${crypto.randomUUID()}`,
    board_id: boardId,
    position: 0,
    role: "broll",
    vo: "",
    shot_type: null,
    style: null,
    image_prompt: "",
    video_prompt: null,
    negative_prompt: null,
    reference_plan: null,
    use_subject_lock: true,
    pose_media_id: null,
    setting_media_id: null,
    extra_media_ids: [],
    generation_id: null,
    generation_ids: [],
    video_model: null,
    video_duration: null,
    video_resolution: null,
    video_generation_id: null,
    video_generation_ids: [],
    created_at: new Date().toISOString(),
    ...from,
  };
}

export function BoardEditor({ initial, profile, concurrency }: { initial: BoardWithBeats; profile: Profile; concurrency: number }) {
  const canEdit = profile.role === "admin" || initial.user_id === profile.id;
  const [board, setBoard] = useState(initial);
  const [beats, setBeats] = useState<Beat[]>(initial.beats);
  const [media, setMedia] = useState<Record<string, Media>>(initial.media);
  const [gens, setGens] = useState<Record<string, ApiGeneration>>(initial.generations);
  const [subject, setSubject] = useState<Subject | null>(initial.subject);
  const [splitting, setSplitting] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const [generating, setGenerating] = useState<Set<string>>(new Set());
  const [animating, setAnimating] = useState<Set<string>>(new Set());
  const [writingVideo, setWritingVideo] = useState(false);
  const [runAll, setRunAll] = useState<{ total: number; done: number } | null>(null);
  const stopRef = useRef(false);
  const beatsRef = useRef(beats);
  useEffect(() => {
    beatsRef.current = beats;
  }, [beats]);

  const model = getModel(board.model) ?? models[0];
  const imageModels = useMemo(() => models.filter((m) => m.mediaType === "image" && m.category === "image"), []);
  const videoModel = getModel(board.video_model) ?? videoModels[0];
  const perClip = useMemo(() => {
    try {
      const o = videoModel.options;
      const duration = o.durations?.includes(board.video_duration) ? board.video_duration : (o.defaultDuration ?? o.durations?.[0]);
      const resolution = o.resolutions ? (board.video_resolution && o.resolutions.includes(board.video_resolution) ? board.video_resolution : (o.defaultResolution ?? o.resolutions[0])) : undefined;
      return estimateCost(videoModel, { prompt: "x", image_urls: [], reference_image_urls: [], reference_video_urls: [], reference_audio_urls: [], elements: [], settings: {}, duration, resolution, generate_audio: false }, 1).perGeneration;
    } catch {
      return null;
    }
  }, [videoModel, board.video_duration, board.video_resolution]);
  const perImage = useMemo(() => {
    try {
      return estimateCost(model, { prompt: "x", image_urls: [], reference_image_urls: [], reference_video_urls: [], reference_audio_urls: [], elements: [], settings: {}, aspect_ratio: board.aspect_ratio, resolution: board.resolution }, 1).perGeneration;
    } catch {
      return null;
    }
  }, [model, board.aspect_ratio, board.resolution]);

  // ─── persistence ──────────────────────────────────────────────────────────

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveBeats = useCallback(async (list: Beat[]) => {
    setSaveState("saving");
    try {
      const res = await api<{ beats: Beat[]; media: Record<string, Media> }>(`/api/boards/${initial.id}/beats`, { method: "PUT", json: { beats: toPayload(list) } });
      // The server assigns real ids to new beats; keep local edits made meanwhile by position.
      setBeats((cur) => (cur.length === res.beats.length ? cur.map((b, i) => ({ ...res.beats[i], vo: b.vo, image_prompt: b.image_prompt, role: b.role, use_subject_lock: b.use_subject_lock, pose_media_id: b.pose_media_id, setting_media_id: b.setting_media_id, extra_media_ids: b.extra_media_ids, video_prompt: b.video_prompt, video_model: b.video_model, video_duration: b.video_duration, video_resolution: b.video_resolution })) : res.beats));
      setMedia((m) => ({ ...m, ...res.media }));
      setSaveState("saved");
    } catch (e) {
      setSaveState("dirty");
      toast.error("Couldn't save beats", { description: e instanceof Error ? e.message : String(e) });
    }
  }, [initial.id]);

  const scheduleSave = useCallback(
    (list: Beat[]) => {
      setSaveState("dirty");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void saveBeats(list), SAVE_DEBOUNCE_MS);
    },
    [saveBeats],
  );

  /** Flushes pending edits and returns the saved list (needed before generating a new beat). */
  const flush = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const list = beatsRef.current;
    if (list.some((b) => b.id.startsWith("new-")) || saveState !== "saved") await saveBeats(list);
    return beatsRef.current;
  }, [saveBeats, saveState]);

  const update = useCallback(
    (next: Beat[]) => {
      setBeats(next);
      scheduleSave(next);
    },
    [scheduleSave],
  );

  async function patchBoard(patch: Partial<Pick<BoardWithBeats, "title" | "script" | "subject_id" | "model" | "aspect_ratio" | "resolution" | "video_model" | "video_duration" | "video_resolution">>) {
    setBoard((b) => ({ ...b, ...patch }));
    try {
      await api(`/api/boards/${initial.id}`, { method: "PATCH", json: patch });
    } catch (e) {
      toast.error("Couldn't save board", { description: e instanceof Error ? e.message : String(e) });
    }
  }
  const scriptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function onScript(script: string) {
    setBoard((b) => ({ ...b, script }));
    if (scriptTimer.current) clearTimeout(scriptTimer.current);
    scriptTimer.current = setTimeout(() => void api(`/api/boards/${initial.id}`, { method: "PATCH", json: { script } }).catch(() => {}), SAVE_DEBOUNCE_MS);
  }

  // ─── beat operations ──────────────────────────────────────────────────────

  const patchBeat = (id: string, patch: BeatPatch) => update(beats.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const splitBeat = (id: string, parts: string[]) => {
    const i = beats.findIndex((b) => b.id === id);
    if (i < 0) return;
    const src = beats[i];
    const extra = parts.slice(1).map((vo) => newBeat(initial.id, { ...src, id: undefined, vo, generation_id: null, generation_ids: [] }));
    update([...beats.slice(0, i), { ...src, vo: parts[0] }, ...extra.map((b) => ({ ...b, id: `new-${crypto.randomUUID()}` })), ...beats.slice(i + 1)]);
  };
  const mergeBeat = (id: string) => {
    const i = beats.findIndex((b) => b.id === id);
    if (i < 0 || i === beats.length - 1) return;
    const a = beats[i];
    const b = beats[i + 1];
    update([...beats.slice(0, i), { ...a, vo: `${a.vo.trim()} ${b.vo.trim()}`.trim(), role: a.role === "broll" || b.role === "broll" ? "broll" : "aroll" }, ...beats.slice(i + 2)]);
  };
  const moveBeat = (id: string, dir: -1 | 1) => {
    const i = beats.findIndex((b) => b.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= beats.length) return;
    const next = [...beats];
    [next[i], next[j]] = [next[j], next[i]];
    update(next);
  };
  const insertAfter = (id: string) => {
    const i = beats.findIndex((b) => b.id === id);
    update([...beats.slice(0, i + 1), newBeat(initial.id, { style: beats[i]?.style ?? null }), ...beats.slice(i + 1)]);
  };
  const deleteBeat = (id: string) => {
    if (!window.confirm("Delete this beat? Its generated images stay in the gallery.")) return;
    update(beats.filter((b) => b.id !== id));
  };

  // ─── the brain ────────────────────────────────────────────────────────────

  async function split() {
    if (!board.script.trim()) return toast.error("Paste a script first");
    if (beats.length && !window.confirm(`Re-splitting replaces the current ${beats.length} beats (generated images stay in the gallery). Continue?`)) return;
    setSplitting(true);
    try {
      if (scriptTimer.current) clearTimeout(scriptTimer.current);
      await api(`/api/boards/${initial.id}`, { method: "PATCH", json: { script: board.script } });
      const res = await api<BoardWithBeats & { usage: { input: number; output: number } }>(`/api/boards/${initial.id}/split`, { method: "POST", json: {} });
      setBeats(res.beats);
      setMedia((m) => ({ ...m, ...res.media }));
      setGens(res.generations);
      setBoard((b) => ({ ...b, brain_output: res.brain_output }));
      setSaveState("saved");
      toast.success(`Split into ${res.beats.length} beats`, { description: `${res.beats.filter((b) => b.role === "broll").length} B-roll · ${res.usage.output.toLocaleString()} tokens` });
    } catch (e) {
      toast.error("Split failed", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSplitting(false);
    }
  }

  // ─── generation ───────────────────────────────────────────────────────────

  /** Starts a generation for one beat; resolves once the job is submitted (not finished). */
  const generate = useCallback(
    async (beatId: string): Promise<string | null> => {
      const list = await flush();
      const beat = list.find((b) => b.id === beatId) ?? list.find((b, i) => beatsRef.current[i]?.id === beatId);
      if (!beat || beat.id.startsWith("new-")) {
        toast.error("Beat not saved yet — try again in a moment");
        return null;
      }
      setGenerating((s) => new Set(s).add(beat.id));
      try {
        const res = await api<{ beat: Beat; generation: ApiGeneration }>(`/api/boards/${initial.id}/beats/${beat.id}/generate`, { method: "POST", json: {} });
        setBeats((cur) => cur.map((b) => (b.id === beat.id ? { ...b, generation_id: res.beat.generation_id, generation_ids: res.beat.generation_ids } : b)));
        setGens((g) => ({ ...g, [res.generation.id]: res.generation }));
        return res.generation.id;
      } catch (e) {
        toast.error("Couldn't generate", { description: e instanceof Error ? e.message : String(e) });
        return null;
      } finally {
        setGenerating((s) => {
          const n = new Set(s);
          n.delete(beat.id);
          return n;
        });
      }
    },
    [flush, initial.id],
  );

  // Poll every in-flight generation shown on the board, rescheduling until none are left.
  const gensRef = useRef(gens);
  useEffect(() => {
    gensRef.current = gens;
  }, [gens]);
  const hasInflight = Object.values(gens).some(isInFlight);
  useEffect(() => {
    if (!hasInflight) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const inflight = Object.values(gensRef.current).filter(isInFlight);
      await Promise.all(
        inflight.map(async (g) => {
          try {
            const s = await api<{ status: ApiGeneration["status"] }>(`/api/generate/${g.id}/status`);
            if (s.status !== g.status) {
              const full = await api<ApiGeneration>(`/api/generate/${g.id}`);
              setGens((cur) => ({ ...cur, [g.id]: full }));
            }
          } catch {
            /* transient; next tick retries */
          }
        }),
      );
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [hasInflight]);

  const waitFor = (genId: string) =>
    new Promise<void>((resolve) => {
      const check = async () => {
        if (stopRef.current) return resolve();
        try {
          const s = await api<{ status: ApiGeneration["status"] }>(`/api/generate/${genId}/status`);
          if (s.status === "completed" || s.status === "failed") {
            const full = await api<ApiGeneration>(`/api/generate/${genId}`);
            setGens((cur) => ({ ...cur, [genId]: full }));
            return resolve();
          }
        } catch {
          /* retry */
        }
        setTimeout(check, POLL_MS);
      };
      setTimeout(check, POLL_MS);
    });

  const reprompt = useCallback(
    async (beatId: string, direction: string, attachResult: boolean) => {
      await flush();
      const r = await api<{ image_prompt: string; diagnosis?: string }>(`/api/boards/${initial.id}/beats/${beatId}/reprompt`, { method: "POST", json: { direction, attach_result: attachResult } });
      // Patch against the latest beats so edits made while waiting aren't lost.
      update(beatsRef.current.map((b) => (b.id === beatId ? { ...b, image_prompt: r.image_prompt } : b)));
      return { prompt: r.image_prompt, diagnosis: r.diagnosis };
    },
    [flush, initial.id, update],
  );

  const repromptVideo = useCallback(
    async (beatId: string, direction: string, attachResult: boolean) => {
      await flush();
      const r = await api<{ video_prompt: string }>(`/api/boards/${initial.id}/beats/${beatId}/reprompt`, { method: "POST", json: { direction, target: "video", attach_result: attachResult } });
      update(beatsRef.current.map((b) => (b.id === beatId ? { ...b, video_prompt: r.video_prompt } : b)));
      return { prompt: r.video_prompt };
    },
    [flush, initial.id, update],
  );

  /** Starts a clip for one beat; resolves once the job is submitted (not finished). */
  const animate = useCallback(
    async (beatId: string): Promise<string | null> => {
      const list = await flush();
      const beat = list.find((b) => b.id === beatId);
      if (!beat || beat.id.startsWith("new-")) {
        toast.error("Beat not saved yet — try again in a moment");
        return null;
      }
      setAnimating((s) => new Set(s).add(beat.id));
      try {
        const res = await api<{ beat: Beat; generation: ApiGeneration }>(`/api/boards/${initial.id}/beats/${beat.id}/animate`, { method: "POST", json: {} });
        setBeats((cur) => cur.map((b) => (b.id === beat.id ? { ...b, video_generation_id: res.beat.video_generation_id, video_generation_ids: res.beat.video_generation_ids } : b)));
        setGens((g) => ({ ...g, [res.generation.id]: res.generation }));
        return res.generation.id;
      } catch (e) {
        toast.error("Couldn't animate", { description: e instanceof Error ? e.message : String(e) });
        return null;
      } finally {
        setAnimating((s) => {
          const n = new Set(s);
          n.delete(beat.id);
          return n;
        });
      }
    },
    [flush, initial.id],
  );

  async function writeVideoPrompts(mode: "missing" | "all") {
    const list = await flush();
    const targets = list.filter((b) => b.role === "broll" && b.image_prompt.trim() && (mode === "all" || (b.video_prompt?.trim().length ?? 0) < 200));
    if (!targets.length) return toast("Nothing to write", { description: mode === "missing" ? "Every B-roll beat already has a video prompt." : "No B-roll beats with an image prompt." });
    if (mode === "all" && !window.confirm(`Rewrite the video prompts on all ${targets.length} B-roll beats? Edits you made by hand will be replaced.`)) return;
    setWritingVideo(true);
    try {
      const res = await api<{ prompts: Record<string, string>; usage: { input: number; output: number } }>(`/api/boards/${initial.id}/video-prompts`, { method: "POST", json: { mode } });
      setBeats((cur) => cur.map((b) => (res.prompts[b.id] ? { ...b, video_prompt: res.prompts[b.id] } : b)));
      toast.success(`Video prompts ready for ${Object.keys(res.prompts).length} beat${Object.keys(res.prompts).length === 1 ? "" : "s"}`, { description: `${res.usage.output.toLocaleString()} tokens` });
    } catch (e) {
      toast.error("Couldn't write video prompts", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setWritingVideo(false);
    }
  }

  async function animateAll(mode: "missing" | "all") {
    const list = await flush();
    const targets = list.filter((b) => b.role === "broll" && b.video_prompt?.trim() && b.generation_id && gens[b.generation_id]?.status === "completed" && (mode === "all" || !(b.video_generation_id && gens[b.video_generation_id]?.status === "completed")));
    if (!targets.length) return toast("Nothing to animate", { description: mode === "missing" ? "Every B-roll beat with a starter image and a video prompt already has a clip." : "No B-roll beats have both a starter image and a video prompt." });
    const cost = perClip != null ? perClip * targets.filter((b) => !b.video_model).length : null;
    const overrides = targets.filter((b) => b.video_model).length;
    if (!window.confirm(`Animate ${targets.length} clip${targets.length === 1 ? "" : "s"}${cost != null ? ` for about ${formatUsd(cost)}${overrides ? ` plus ${overrides} with their own model` : ""}` : ""}, ${concurrency} at a time?`)) return;
    stopRef.current = false;
    setRunAll({ total: targets.length, done: 0 });
    const queue = [...targets];
    await Promise.all(
      Array.from({ length: Math.max(1, concurrency) }, async () => {
        while (queue.length && !stopRef.current) {
          const beat = queue.shift()!;
          const id = await animate(beat.id);
          if (id) await waitFor(id);
          setRunAll((r) => (r ? { ...r, done: r.done + 1 } : r));
        }
      }),
    );
    setRunAll(null);
    toast.success(stopRef.current ? "Stopped" : "Animate all finished");
  }

  async function generateAll(mode: "missing" | "all") {
    const list = await flush();
    const targets = list.filter((b) => b.role === "broll" && b.image_prompt.trim() && (mode === "all" || !(b.generation_id && gens[b.generation_id]?.status === "completed")));
    if (!targets.length) return toast("Nothing to generate", { description: mode === "missing" ? "Every B-roll beat already has an image." : "No B-roll beats with a prompt." });
    const cost = perImage != null ? perImage * targets.length : null;
    if (!window.confirm(`Generate ${targets.length} starter image${targets.length === 1 ? "" : "s"}${cost != null ? ` for about ${formatUsd(cost)}` : ""}, ${concurrency} at a time?`)) return;
    stopRef.current = false;
    setRunAll({ total: targets.length, done: 0 });
    const queue = [...targets];
    await Promise.all(
      Array.from({ length: Math.max(1, concurrency) }, async () => {
        while (queue.length && !stopRef.current) {
          const beat = queue.shift()!;
          const id = await generate(beat.id);
          if (id) await waitFor(id);
          setRunAll((r) => (r ? { ...r, done: r.done + 1 } : r));
        }
      }),
    );
    setRunAll(null);
    toast.success(stopRef.current ? "Stopped" : "Generate all finished");
  }

  async function showGeneration(beatId: string, genId: string, kind: "image" | "video" = "image") {
    try {
      const g = gens[genId] ?? (await fetchGeneration(genId));
      setGens((cur) => ({ ...cur, [genId]: g }));
      setBeats((cur) => cur.map((b) => (b.id === beatId ? (kind === "video" ? { ...b, video_generation_id: genId } : { ...b, generation_id: genId }) : b)));
    } catch (e) {
      toast.error("Couldn't load that take", { description: e instanceof Error ? e.message : String(e) });
    }
  }

  const brollCount = beats.filter((b) => b.role === "broll").length;
  const doneCount = beats.filter((b) => b.role === "broll" && b.generation_id && gens[b.generation_id]?.status === "completed").length;
  const clipCount = beats.filter((b) => b.role === "broll" && b.video_generation_id && gens[b.video_generation_id]?.status === "completed").length;

  return (
    <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
      {/* ─── left: script + board settings ─── */}
      <aside className="space-y-5 lg:sticky lg:top-20 lg:self-start">
        <div>
          <Link href="/boards" className="text-xs text-cream-2 hover:text-cream">
            ← All boards
          </Link>
          <Input value={board.title} readOnly={!canEdit} onChange={(e) => setBoard((b) => ({ ...b, title: e.target.value }))} onBlur={(e) => canEdit && e.target.value.trim() && e.target.value !== initial.title && void patchBoard({ title: e.target.value.trim() })} className="mt-2 font-serif text-lg" />
        </div>

        <div>
          <Label className="mb-1.5">Script</Label>
          <Textarea value={board.script} readOnly={!canEdit} onChange={(e) => onScript(e.target.value)} rows={14} placeholder="Paste the full ad script…" className="font-sans text-[13px]" />
          <Button variant="gold" className="mt-2 w-full" disabled={!canEdit || splitting || !board.script.trim()} onClick={split}>
            {splitting ? <Loader2 className="animate-spin" /> : <Wand2 />}
            {splitting ? "Splitting with Claude…" : beats.length ? "Re-split into beats" : "Split into beats"}
          </Button>
          {board.brain_output?.subject_lock ? <p className="mt-2 line-clamp-3 text-[11px] leading-snug text-muted" title={board.brain_output.subject_lock}>Brain&apos;s subject: {board.brain_output.subject_lock}</p> : null}
        </div>

        <SubjectPicker
          value={subject}
          userId={profile.id}
          canEdit={canEdit}
          onChange={(s) => {
            setSubject(s);
            void patchBoard({ subject_id: s?.id ?? null });
          }}
        />

        <div className="space-y-3">
          <div>
            <Label className="mb-1.5">Image model</Label>
            <NativeSelect value={board.model} disabled={!canEdit} onChange={(e) => void patchBoard({ model: e.target.value })}>
              {imageModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          {model.options.aspectRatios ? (
            <div>
              <Label className="mb-1.5">Aspect ratio</Label>
              <Segmented size="sm" value={board.aspect_ratio} options={model.options.aspectRatios.map((v) => ({ value: v }))} onChange={(v) => canEdit && void patchBoard({ aspect_ratio: v })} />
            </div>
          ) : null}
          {model.options.resolutions ? (
            <div>
              <Label className="mb-1.5">Resolution</Label>
              <Segmented size="sm" value={board.resolution} options={model.options.resolutions.map((v) => ({ value: v }))} onChange={(v) => canEdit && void patchBoard({ resolution: v })} />
            </div>
          ) : null}
          {perImage != null ? <p className="text-[11px] text-muted">About {formatUsd(perImage)} per image · {concurrency} at a time</p> : null}
        </div>

        <div className="space-y-3 border-t border-hairline pt-4">
          <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-cream-2">
            <Clapperboard className="size-3" /> Video defaults
          </div>
          <div>
            <Label className="mb-1.5">Video model</Label>
            <NativeSelect value={board.video_model} disabled={!canEdit} onChange={(e) => void patchBoard({ video_model: e.target.value, video_resolution: null })}>
              {videoModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.tier ? `${m.name} ${m.tier}` : m.name}
                </option>
              ))}
            </NativeSelect>
            {videoModel.description ? <p className="mt-1 text-[11px] text-muted">{videoModel.description}</p> : null}
          </div>
          {videoModel.options.durations ? (
            <div>
              <Label className="mb-1.5">Length</Label>
              <Segmented size="sm" value={videoModel.options.durations.includes(board.video_duration) ? String(board.video_duration) : String(videoModel.options.defaultDuration ?? videoModel.options.durations[0])} options={videoModel.options.durations.map((d) => ({ value: String(d), label: `${d}s` }))} onChange={(v) => canEdit && void patchBoard({ video_duration: Number(v) })} />
            </div>
          ) : null}
          {videoModel.options.resolutions ? (
            <div>
              <Label className="mb-1.5">Quality</Label>
              <Segmented size="sm" value={board.video_resolution && videoModel.options.resolutions.includes(board.video_resolution) ? board.video_resolution : (videoModel.options.defaultResolution ?? videoModel.options.resolutions[0])} options={videoModel.options.resolutions.map((v) => ({ value: v }))} onChange={(v) => canEdit && void patchBoard({ video_resolution: v })} />
            </div>
          ) : null}
          {perClip != null ? <p className="text-[11px] text-muted">About {formatUsd(perClip)} per clip · each card can override these</p> : null}
        </div>
      </aside>

      {/* ─── right: beats ─── */}
      <section className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 className="font-serif text-2xl text-cream">Beats</h2>
          <span className="text-xs text-cream-2">
            {beats.length} total · {brollCount} B-roll · {doneCount} images · {clipCount} clips
          </span>
          <span className={cn("flex items-center gap-1 text-[11px]", saveState === "saved" ? "text-muted" : "text-gold")}>
            {saveState === "saving" ? <Loader2 className="size-3 animate-spin" /> : saveState === "saved" ? <Check className="size-3" /> : null}
            {saveState === "saving" ? "Saving" : saveState === "saved" ? "Saved" : "Unsaved"}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {runAll ? (
              <>
                <span className="font-mono text-xs text-cream-2">
                  {runAll.done}/{runAll.total}
                </span>
                <Button variant="danger" size="sm" onClick={() => (stopRef.current = true)}>
                  <Square /> Stop
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" disabled={!canEdit || !brollCount} onClick={() => void generateAll("all")}>
                  <Play /> Regenerate all
                </Button>
                <Button variant="gold" size="sm" disabled={!canEdit || !brollCount} onClick={() => void generateAll("missing")}>
                  <Sparkles /> Generate missing
                </Button>
                <span className="mx-1 h-5 w-px bg-hairline" />
                <Button variant="outline" size="sm" disabled={!canEdit || !brollCount || writingVideo} onClick={() => void writeVideoPrompts("missing")} title="Have Claude write a full video prompt for every B-roll beat that only has the one-line hint (or none)">
                  {writingVideo ? <Loader2 className="animate-spin" /> : <Wand2 />} {writingVideo ? "Writing…" : "Write video prompts"}
                </Button>
                <Button variant="outline" size="sm" disabled={!canEdit || !doneCount} onClick={() => void animateAll("all")}>
                  <RotateCw /> Re-animate all
                </Button>
                <Button variant="gold" size="sm" disabled={!canEdit || !doneCount} onClick={() => void animateAll("missing")}>
                  <Clapperboard /> Animate missing
                </Button>
              </>
            )}
          </div>
        </div>

        {beats.length === 0 ? (
          <div className="rounded-[8px] border border-dashed border-hairline px-6 py-20 text-center">
            <p className="font-serif text-xl text-cream">No beats yet</p>
            <p className="mt-2 text-sm text-cream-2">Paste the script on the left and press Split, or add beats by hand.</p>
            {canEdit ? (
              <Button variant="outline" className="mt-5" onClick={() => update([newBeat(initial.id)])}>
                Add a beat
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            {beats.map((beat, i) => (
              <BeatCard
                key={beat.id}
                beat={beat}
                index={i}
                total={beats.length}
                subject={subject}
                media={media}
                generation={beat.generation_id ? (gens[beat.generation_id] ?? null) : null}
                generating={generating.has(beat.id)}
                videoGeneration={beat.video_generation_id ? (gens[beat.video_generation_id] ?? null) : null}
                animating={animating.has(beat.id)}
                videoDefaults={{ model: board.video_model, duration: board.video_duration, resolution: board.video_resolution }}
                userId={profile.id}
                canEdit={canEdit}
                onPatch={(p) => patchBeat(beat.id, p)}
                onMedia={(m: ApiMedia) => setMedia((cur) => ({ ...cur, [m.id]: m }))}
                onSplit={(parts) => splitBeat(beat.id, parts)}
                onMerge={() => mergeBeat(beat.id)}
                onMove={(dir) => moveBeat(beat.id, dir)}
                onInsertAfter={() => insertAfter(beat.id)}
                onDelete={() => deleteBeat(beat.id)}
                onGenerate={() => void generate(beat.id)}
                onReprompt={(direction, attach) => reprompt(beat.id, direction, attach)}
                onShowGeneration={(id) => void showGeneration(beat.id, id)}
                onAnimate={() => void animate(beat.id)}
                onRepromptVideo={(direction, attach) => repromptVideo(beat.id, direction, attach)}
                onShowVideoGeneration={(id) => void showGeneration(beat.id, id, "video")}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

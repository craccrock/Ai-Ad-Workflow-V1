"use client";

import { Check, Clapperboard, Download, Film, Layers, Loader2, Play, RotateCw, Scissors, Sparkles, Square, UserRound, Wand2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { AVATAR_MODEL_IDS, avatarDurationFor, DEFAULT_AVATAR_MODEL } from "@/config/avatar";
import type { LearningTag } from "@/config/learning-tags";
import { getModel, models } from "@/config/models.config";
import { api, downloadFile, type ApiGeneration, type ApiMedia } from "@/lib/client-api";
import { estimateCost } from "@/lib/generation-params";
import type { AvatarAssembly, AvatarChunk, Beat, BoardWithBeats, FinalAssembly, Media, Profile, Subject } from "@/lib/types";
import { cn, formatUsd } from "@/lib/utils";
import { AvatarCard, MIN_AVATAR_PROMPT_CHARS, type ChunkPatch } from "./avatar-card";
import { BeatCard, clipCost, fetchGeneration, videoModels, videoOptionLabel, type BeatPatch } from "./beat-card";
import { CaptionsPanel } from "./captions-panel";
import { CostBreakdown } from "./cost-breakdown";
import { EditNotes } from "./edit-notes";
import { RefSlot } from "./ref-slot";
import { SubjectPicker } from "./subject-picker";

/** Talking-head models, in the order the Avatar tab offers them. */
const avatarModels = AVATAR_MODEL_IDS.map((id) => getModel(id)).filter((m): m is NonNullable<typeof m> => Boolean(m));

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
    overlay_enabled: b.overlay_enabled ?? true,
    overlay_in: Number(b.overlay_in ?? 0),
    overlay_max: b.overlay_max == null ? null : Number(b.overlay_max),
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
    overlay_enabled: true,
    overlay_in: 0,
    overlay_max: null,
    video_generation_id: null,
    video_generation_ids: [],
    created_at: new Date().toISOString(),
    ...from,
  };
}

/** Progress for Generate-all / Animate-all: a bar, done/total, and how many jobs are in flight right now. */
function RunProgress({ done, total, inFlight }: { done: number; total: number; inFlight: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2" title={`${done} of ${total} finished · ${inFlight} running at once`}>
      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-gold/80 transition-[width] duration-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-xs text-cream-2">
        {done}/{total}
        <span className="text-muted"> · {inFlight} running</span>
      </span>
    </div>
  );
}

export function BoardEditor({ initial, profile, concurrency }: { initial: BoardWithBeats; profile: Profile; concurrency: number }) {
  const canEdit = profile.role === "admin" || initial.user_id === profile.id;
  const [board, setBoard] = useState(initial);
  const [beats, setBeats] = useState<Beat[]>(initial.beats);
  const [media, setMedia] = useState<Record<string, Media>>(initial.media);
  const [gens, setGens] = useState<Record<string, ApiGeneration>>(initial.generations);
  const [subject, setSubject] = useState<Subject | null>(initial.subject);
  const [splitting, setSplitting] = useState(false);
  const [redoNote, setRedoNote] = useState("");
  const [redoRemember, setRedoRemember] = useState(true);
  // The redo note is kept in this browser as it is typed, so a refresh, a crash or a failed redo never loses it.
  const redoKey = `redo-note:${initial.id}`;
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(redoKey);
        if (saved) setRedoNote(saved);
      } catch {}
    }, 0);
    return () => clearTimeout(t);
  }, [redoKey]);
  const changeRedoNote = (v: string) => {
    setRedoNote(v);
    try {
      if (v.trim()) window.localStorage.setItem(redoKey, v);
      else window.localStorage.removeItem(redoKey);
    } catch {}
  };
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");
  const [generating, setGenerating] = useState<Set<string>>(new Set());
  const [animating, setAnimating] = useState<Set<string>>(new Set());
  const [writingVideo, setWritingVideo] = useState(false);
  const [tab, setTab] = useState<"board" | "avatar">("board");
  const [chunks, setChunks] = useState<AvatarChunk[]>(initial.avatar_chunks ?? []);
  const chunksRef = useRef(chunks);
  useEffect(() => {
    chunksRef.current = chunks;
  }, [chunks]);
  const [chunking, setChunking] = useState(false);
  const [writingAvatar, setWritingAvatar] = useState(false);
  const [assembling, setAssembling] = useState(false);
  const [assemblingFinal, setAssemblingFinal] = useState(false);
  const [runAll, setRunAll] = useState<{ total: number; done: number } | null>(null);
  const stopRef = useRef(false);
  /** Generation ids the editor has given a thumbs-up on this board. */
  const [approved, setApproved] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    void api<{ approved: string[] }>(`/api/boards/${initial.id}/feedback?approved=1`)
      .then((r) => alive && setApproved(new Set(r.approved)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [initial.id]);
  const beatsRef = useRef(beats);
  useEffect(() => {
    beatsRef.current = beats;
  }, [beats]);

  const model = getModel(board.model) ?? models[0];
  const imageModels = useMemo(() => models.filter((m) => m.mediaType === "image" && m.category === "image"), []);
  const videoModel = getModel(board.video_model) ?? videoModels[0];
  const perClip = useMemo(() => clipCost(videoModel, board.video_duration, board.video_resolution), [videoModel, board.video_duration, board.video_resolution]);
  /** What one beat's clip costs with its own model, length and quality overrides applied over the board's defaults. */
  const beatClipCost = useCallback(
    (b: Pick<Beat, "video_model" | "video_duration" | "video_resolution">) => clipCost(getModel(b.video_model ?? board.video_model) ?? videoModel, b.video_duration ?? board.video_duration, b.video_resolution ?? board.video_resolution),
    [board.video_model, board.video_duration, board.video_resolution, videoModel],
  );
  const brollBeats = useMemo(() => beats.filter((b) => b.role === "broll"), [beats]);
  const brollClipTotal = useMemo(() => {
    const costs = brollBeats.map(beatClipCost);
    return costs.length && costs.every((c) => c != null) ? costs.reduce((a: number, c) => a + (c ?? 0), 0) : null;
  }, [brollBeats, beatClipCost]);
  // ─── avatar phase ─────────────────────────────────────────────────────────
  const avatarModelId = board.avatar_model || DEFAULT_AVATAR_MODEL;
  const avatarModel = getModel(avatarModelId) ?? avatarModels[0];
  const avatarDurations = useMemo(() => avatarModel.options.durations ?? [4, 6, 8, 10], [avatarModel]);
  const avatarResolution = avatarModel.options.resolutions ? (board.avatar_resolution && avatarModel.options.resolutions.includes(board.avatar_resolution) ? board.avatar_resolution : (avatarModel.options.defaultResolution ?? avatarModel.options.resolutions[0])) : undefined;
  const avatarMedia: Media | null = (board.avatar_media_id ? media[board.avatar_media_id] : null) ?? subject?.media ?? null;
  const avatarReady = Boolean(avatarMedia?.url);
  const avatarClipCost = useCallback(
    (duration: number) => {
      try {
        return estimateCost(avatarModel, { prompt: "x", image_urls: [], reference_image_urls: [], reference_video_urls: [], reference_audio_urls: [], elements: [], settings: {}, duration, resolution: avatarResolution, generate_audio: true }, 1).perGeneration;
      } catch {
        return null;
      }
    },
    [avatarModel, avatarResolution],
  );
  const avatarDurationOf = useCallback((c: Pick<AvatarChunk, "vo" | "duration">) => (c.duration && avatarDurations.includes(c.duration) ? c.duration : avatarDurationFor(c.vo, avatarDurations)), [avatarDurations]);

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
      setBeats((cur) => (cur.length === res.beats.length ? cur.map((b, i) => ({ ...res.beats[i], vo: b.vo, image_prompt: b.image_prompt, role: b.role, use_subject_lock: b.use_subject_lock, pose_media_id: b.pose_media_id, setting_media_id: b.setting_media_id, extra_media_ids: b.extra_media_ids, video_prompt: b.video_prompt, video_model: b.video_model, video_duration: b.video_duration, video_resolution: b.video_resolution, overlay_enabled: b.overlay_enabled, overlay_in: b.overlay_in, overlay_max: b.overlay_max })) : res.beats));
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
      // Keep the ref current at once: handlers that run before the next render (a patch right after a reprompt
      // lands) must build on this list, not on the one from their own render, or they write the old prompt back.
      beatsRef.current = next;
      setBeats(next);
      scheduleSave(next);
    },
    [scheduleSave],
  );

  async function patchBoard(patch: Partial<Pick<BoardWithBeats, "title" | "script" | "subject_id" | "model" | "aspect_ratio" | "resolution" | "video_model" | "video_duration" | "video_resolution" | "avatar_media_id" | "avatar_model" | "avatar_resolution">>) {
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

  const patchBeat = (id: string, patch: BeatPatch) => update(beatsRef.current.map((b) => (b.id === id ? { ...b, ...patch } : b)));
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
    const direction = beats.length ? redoNote.trim() : "";
    if (beats.length && !window.confirm(`${direction ? "Redo the whole board with your direction? This" : "Re-splitting"} replaces the current ${beats.length} beats and their prompts (generated images stay in the gallery).${direction ? "" : " No direction is written in the box, so Claude will write it the same way as before."} Continue?`)) return;
    setSplitting(true);
    try {
      if (scriptTimer.current) clearTimeout(scriptTimer.current);
      await api(`/api/boards/${initial.id}`, { method: "PATCH", json: { script: board.script } });
      const res = await api<BoardWithBeats & { usage: { input: number; output: number }; remembered?: boolean }>(`/api/boards/${initial.id}/split`, { method: "POST", json: direction ? { direction, remember: redoRemember } : {} });
      setBeats(res.beats);
      setMedia((m) => ({ ...m, ...res.media }));
      setGens(res.generations);
      setBoard((b) => ({ ...b, brain_output: res.brain_output }));
      setSaveState("saved");
      toast.success(direction ? `Board redone: ${res.beats.length} beats` : `Split into ${res.beats.length} beats`, { description: `${res.beats.filter((b) => b.role === "broll").length} B-roll · ${res.usage.output.toLocaleString()} tokens${res.remembered ? " · direction saved as a standing rule" : ""}` });
      if (direction) changeRedoNote("");
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
    async (beatId: string, direction: string, attachResult: boolean, exampleUrls: string[], fresh = false) => {
      await flush();
      const r = await api<{ image_prompt: string; reference_plan: Beat["reference_plan"]; diagnosis?: string }>(`/api/boards/${initial.id}/beats/${beatId}/reprompt`, { method: "POST", json: { direction, attach_result: attachResult, example_urls: exampleUrls, fresh } });
      // Patch against the latest beats so edits made while waiting aren't lost. The server dropped the brain's edit note, mirror that here.
      update(beatsRef.current.map((b) => (b.id === beatId ? { ...b, image_prompt: r.image_prompt, reference_plan: r.reference_plan } : b)));
      return { prompt: r.image_prompt, diagnosis: r.diagnosis };
    },
    [flush, initial.id, update],
  );

  const repromptVideo = useCallback(
    async (beatId: string, direction: string, attachResult: boolean, exampleUrls: string[], fresh = false) => {
      await flush();
      const r = await api<{ video_prompt: string }>(`/api/boards/${initial.id}/beats/${beatId}/reprompt`, { method: "POST", json: { direction, target: "video", attach_result: attachResult, example_urls: exampleUrls, fresh } });
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
    const costs = targets.map(beatClipCost);
    const cost = costs.every((c) => c != null) ? costs.reduce((a: number, c) => a + (c ?? 0), 0) : null;
    const overrides = targets.filter((b) => b.video_model || b.video_duration || b.video_resolution).length;
    if (!window.confirm(`Animate ${targets.length} clip${targets.length === 1 ? "" : "s"}${cost != null ? ` for about ${formatUsd(cost)}${overrides ? ` (${overrides} with their own settings, included)` : ""}` : ""}, ${concurrency} at a time?`)) return;
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
      // Persist the choice: Reprompt, Animate and the next save read the beat from the server, not from this tab.
      if (!beatId.startsWith("new-")) await api(`/api/boards/${initial.id}/beats/${beatId}/take`, { method: "PATCH", json: { kind, generation_id: genId } });
    } catch (e) {
      toast.error("Couldn't switch take", { description: e instanceof Error ? e.message : String(e) });
    }
  }

  // ─── avatar actions ───────────────────────────────────────────────────────

  // Chunk edits (line, length, prompt) save on a debounce, like beats.
  const chunkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [chunkSave, setChunkSave] = useState<"saved" | "dirty" | "saving">("saved");
  const saveChunks = useCallback(
    async (list: AvatarChunk[]) => {
      setChunkSave("saving");
      try {
        await api(`/api/boards/${initial.id}/avatar/chunks`, { method: "PUT", json: { chunks: list.map((c) => ({ id: c.id, vo: c.vo, duration: c.duration, video_prompt: c.video_prompt })) } });
        setChunkSave("saved");
      } catch (e) {
        setChunkSave("dirty");
        toast.error("Couldn't save chunks", { description: e instanceof Error ? e.message : String(e) });
      }
    },
    [initial.id],
  );
  const updateChunks = useCallback(
    (next: AvatarChunk[]) => {
      setChunks(next);
      setChunkSave("dirty");
      if (chunkTimer.current) clearTimeout(chunkTimer.current);
      chunkTimer.current = setTimeout(() => void saveChunks(next), SAVE_DEBOUNCE_MS);
    },
    [saveChunks],
  );
  const flushChunks = useCallback(async () => {
    if (chunkTimer.current) {
      clearTimeout(chunkTimer.current);
      chunkTimer.current = null;
      await saveChunks(chunksRef.current);
    }
    return chunksRef.current;
  }, [saveChunks]);
  const patchChunk = (id: string, patch: ChunkPatch) => updateChunks(chunks.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  /** Cuts the WHOLE script into clip-sized chunks (server-side, via Claude). Replaces the current chunk list. */
  async function chunkScript() {
    if (!board.script.trim() && !beats.some((b) => b.vo.trim())) return toast.error("Paste the script first");
    const withClips = chunks.filter((c) => c.generation_ids?.length).length;
    if (chunks.length && !window.confirm(`Re-cut the script into ${Math.max(...avatarDurations)}s-or-shorter chunks? The current ${chunks.length} chunks and their prompts are replaced${withClips ? `, and ${withClips} chunk${withClips === 1 ? "" : "s"} lose their clips (the videos stay in the gallery)` : ""}. The storyboard is untouched.`)) return;
    setChunking(true);
    try {
      if (scriptTimer.current) {
        clearTimeout(scriptTimer.current);
        await api(`/api/boards/${initial.id}`, { method: "PATCH", json: { script: board.script } });
      }
      const res = await api<{ chunks: AvatarChunk[]; usage: { input: number; output: number } }>(`/api/boards/${initial.id}/avatar/chunks`, { method: "POST", json: {} });
      setChunks(res.chunks);
      setChunkSave("saved");
      toast.success(`Script cut into ${res.chunks.length} chunk${res.chunks.length === 1 ? "" : "s"}`, { description: "Packed at quick UGC pace. Next: write the avatar prompts." });
    } catch (e) {
      toast.error("Couldn't chunk the script", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setChunking(false);
    }
  }

  async function writeAvatarPrompts(mode: "missing" | "all") {
    const list = await flushChunks();
    const targets = list.filter((c) => c.vo.trim() && (mode === "all" || (c.video_prompt?.trim().length ?? 0) < MIN_AVATAR_PROMPT_CHARS));
    if (!targets.length) return toast("Nothing to write", { description: mode === "missing" ? "Every chunk already has an avatar prompt." : "No chunks yet — chunk the script first." });
    if (!avatarReady) return toast.error("Add an avatar still first");
    if (mode === "all" && !window.confirm(`Rewrite the avatar prompts on all ${targets.length} chunks? Edits you made by hand will be replaced.`)) return;
    setWritingAvatar(true);
    try {
      const res = await api<{ prompts: Record<string, string>; usage: { input: number; output: number } }>(`/api/boards/${initial.id}/avatar/prompts`, { method: "POST", json: { mode } });
      setChunks((cur) => cur.map((c) => (res.prompts[c.id] ? { ...c, video_prompt: res.prompts[c.id] } : c)));
      toast.success(`Avatar prompts ready for ${Object.keys(res.prompts).length} chunk${Object.keys(res.prompts).length === 1 ? "" : "s"}`, { description: `${res.usage.output.toLocaleString()} tokens` });
    } catch (e) {
      toast.error("Couldn't write avatar prompts", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setWritingAvatar(false);
    }
  }

  const repromptChunk = useCallback(
    async (chunkId: string, direction: string, exampleUrls: string[], fresh: boolean) => {
      await flushChunks();
      const r = await api<{ video_prompt: string }>(`/api/boards/${initial.id}/avatar/chunks/${chunkId}/reprompt`, { method: "POST", json: { direction, example_urls: exampleUrls, fresh } });
      setChunks(chunksRef.current.map((c) => (c.id === chunkId ? { ...c, video_prompt: r.video_prompt } : c)));
    },
    [flushChunks, initial.id],
  );

  /** Starts the talking-head clip for one chunk; resolves once the job is submitted. */
  const animateChunk = useCallback(
    async (chunkId: string): Promise<string | null> => {
      await flushChunks();
      setAnimating((s) => new Set(s).add(chunkId));
      try {
        const res = await api<{ chunk: AvatarChunk; generation: ApiGeneration }>(`/api/boards/${initial.id}/avatar/chunks/${chunkId}/animate`, { method: "POST", json: {} });
        setChunks((cur) => cur.map((c) => (c.id === chunkId ? { ...c, generation_id: res.chunk.generation_id, generation_ids: res.chunk.generation_ids } : c)));
        setGens((g) => ({ ...g, [res.generation.id]: res.generation }));
        return res.generation.id;
      } catch (e) {
        toast.error("Couldn't generate the clip", { description: e instanceof Error ? e.message : String(e) });
        return null;
      } finally {
        setAnimating((s) => {
          const n = new Set(s);
          n.delete(chunkId);
          return n;
        });
      }
    },
    [flushChunks, initial.id],
  );

  async function animateAvatarAll(mode: "missing" | "all") {
    const list = await flushChunks();
    if (!avatarReady) return toast.error("Add an avatar still first");
    const targets = list.filter((c) => (c.video_prompt?.trim().length ?? 0) >= MIN_AVATAR_PROMPT_CHARS && (mode === "all" || !(c.generation_id && gens[c.generation_id]?.status === "completed")));
    if (!targets.length) return toast("Nothing to generate", { description: mode === "missing" ? "Every chunk with a prompt already has a clip." : "No chunks have an avatar prompt yet." });
    const costs = targets.map((c) => avatarClipCost(avatarDurationOf(c)));
    const cost = costs.every((c) => c != null) ? costs.reduce((s, c) => s + (c ?? 0), 0) : null;
    if (!window.confirm(`Generate ${targets.length} talking-head clip${targets.length === 1 ? "" : "s"} with ${avatarModel.name}${cost != null ? ` for about ${formatUsd(cost)}` : ""}, ${concurrency} at a time?`)) return;
    stopRef.current = false;
    setRunAll({ total: targets.length, done: 0 });
    const queue = [...targets];
    await Promise.all(
      Array.from({ length: Math.max(1, concurrency) }, async () => {
        while (queue.length && !stopRef.current) {
          const chunk = queue.shift()!;
          const id = await animateChunk(chunk.id);
          if (id) await waitFor(id);
          setRunAll((r) => (r ? { ...r, done: r.done + 1 } : r));
        }
      }),
    );
    setRunAll(null);
    toast.success(stopRef.current ? "Stopped" : "Avatar clips finished");
  }

  async function showChunkGeneration(chunkId: string, genId: string) {
    try {
      const g = gens[genId] ?? (await fetchGeneration(genId));
      setGens((cur) => ({ ...cur, [genId]: g }));
      setChunks((cur) => cur.map((c) => (c.id === chunkId ? { ...c, generation_id: genId } : c)));
      // Persist the choice: Assemble reads each chunk's current clip from the server.
      await api(`/api/boards/${initial.id}/avatar/chunks/${chunkId}/take`, { method: "PATCH", json: { generation_id: genId } });
    } catch (e) {
      toast.error("Couldn't switch clip", { description: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Thumbs-down with a reason: a learning event against the prompt that made the take. Nothing is changed. */
  /** Thumbs-up (or taking it back): the approved take's prompt becomes an example the prompt writers read. */
  async function approve(target_type: "beat_image" | "beat_video" | "chunk", target_id: string, generation_id: string, on: boolean) {
    await api(`/api/boards/${initial.id}/feedback`, { method: "POST", json: { target_type, target_id, generation_id, vote: on ? "up" : "clear" } });
    setApproved((cur) => {
      const next = new Set(cur);
      if (on) next.add(generation_id);
      else next.delete(generation_id);
      return next;
    });
  }

  async function feedback(target_type: "beat_image" | "beat_video" | "chunk", target_id: string, generation_id: string, tag: LearningTag, note: string) {
    await api(`/api/boards/${initial.id}/feedback`, { method: "POST", json: { target_type, target_id, generation_id, tag, note: note || undefined } });
  }

  async function deleteChunkTake(chunkId: string, genId: string) {
    const res = await api<{ generation_id: string | null; generation_ids: string[] }>(`/api/boards/${initial.id}/avatar/chunks/${chunkId}/takes/${genId}`, { method: "DELETE" });
    setChunks((cur) => cur.map((c) => (c.id === chunkId ? { ...c, generation_id: res.generation_id, generation_ids: res.generation_ids } : c)));
    setGens((cur) => {
      const next = { ...cur };
      delete next[genId];
      return next;
    });
    toast.success("Clip deleted");
  }

  /** Joins every chunk's clip into one talking-head track (server-side ffmpeg; hard cuts, tails trimmed). */
  async function assembleAroll() {
    const list = await flushChunks();
    const ready = list.filter((c) => c.generation_id && gens[c.generation_id]?.status === "completed").length;
    if (ready < list.length) return toast.error(`${list.length - ready} chunk${list.length - ready === 1 ? " has" : "s have"} no finished clip yet`);
    if (board.avatar_assembly && !window.confirm("Assemble again? The current A-roll track is replaced.")) return;
    setAssembling(true);
    try {
      const res = await api<{ assembly: AvatarAssembly }>(`/api/boards/${initial.id}/avatar/assemble`, { method: "POST", json: {} });
      setBoard((b) => ({ ...b, avatar_assembly: res.assembly }));
      toast.success(`A-roll assembled · ${res.assembly.duration_s}s`, { description: `${res.assembly.chunk_ids.length} clips joined, tails trimmed.` });
    } catch (e) {
      toast.error("Couldn't assemble the A-roll", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setAssembling(false);
    }
  }

  /** Lays the B-roll clips over the A-roll track where their lines are spoken (transcribes the track once). */
  async function assembleFinal() {
    await flush();
    if (!board.avatar_assembly) return toast.error("Assemble the A-roll first");
    const ready = beats.filter((b) => b.role === "broll" && b.overlay_enabled !== false && b.video_generation_id && gens[b.video_generation_id]?.status === "completed").length;
    if (!ready) return toast.error("No B-roll clips to lay over yet");
    const needsTranscript = !board.avatar_assembly.words?.length;
    if (!window.confirm(`Cut ${ready} B-roll clip${ready === 1 ? "" : "s"} over the A-roll?${needsTranscript ? " The A-roll is transcribed first (ElevenLabs Scribe, a few cents)." : ""}${board.final_assembly ? " The current finished ad is replaced." : ""}`)) return;
    setAssemblingFinal(true);
    try {
      const res = await api<{ assembly: FinalAssembly; avatar_assembly: AvatarAssembly }>(`/api/boards/${initial.id}/assemble-final`, { method: "POST", json: {} });
      setBoard((b) => ({ ...b, final_assembly: res.assembly, avatar_assembly: res.avatar_assembly }));
      toast.success(`Finished ad · ${res.assembly.duration_s}s`, { description: `${res.assembly.placements.length} B-roll clip${res.assembly.placements.length === 1 ? "" : "s"} placed${res.assembly.skipped.length ? `, ${res.assembly.skipped.length} skipped` : ""}.` });
    } catch (e) {
      toast.error("Couldn't cut the B-roll in", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setAssemblingFinal(false);
    }
  }

  /** Deletes one take (image or clip) from a beat, for good. The server picks the neighbouring take as current. */
  /** Puts the editor's own image on a beat as its current take (recorded server-side as a finished, free take). */
  async function uploadTake(beatId: string, m: ApiMedia) {
    const list = await flush();
    const beat = list.find((b) => b.id === beatId) ?? list[beatsRef.current.findIndex((b) => b.id === beatId)];
    if (!beat || beat.id.startsWith("new-")) throw new Error("Beat not saved yet. Try again in a moment.");
    const res = await api<{ generation: ApiGeneration; generation_id: string; generation_ids: string[] }>(`/api/boards/${initial.id}/beats/${beat.id}/takes/upload`, { method: "POST", json: { media_id: m.id } });
    setGens((cur) => ({ ...cur, [res.generation.id]: res.generation }));
    setMedia((cur) => ({ ...cur, [m.id]: m }));
    const next = beatsRef.current.map((b) => (b.id === beat.id ? { ...b, generation_id: res.generation_id, generation_ids: res.generation_ids } : b));
    beatsRef.current = next;
    setBeats(next);
    toast.success("Your image is now this beat's take", { description: "Animate uses it as the starting frame." });
  }

  async function deleteTake(beatId: string, genId: string) {
    const res = await api<{ kind: "image" | "video" } & Partial<Pick<Beat, "generation_id" | "generation_ids" | "video_generation_id" | "video_generation_ids">>>(`/api/boards/${initial.id}/beats/${beatId}/takes/${genId}`, { method: "DELETE" });
    const { kind, ...patch } = res;
    setBeats((cur) => cur.map((b) => (b.id === beatId ? { ...b, ...patch } : b)));
    setGens((cur) => {
      const next = { ...cur };
      delete next[genId];
      return next;
    });
    toast.success(kind === "image" ? "Take deleted" : "Clip deleted");
  }

  const brollCount = beats.filter((b) => b.role === "broll").length;
  const doneCount = beats.filter((b) => b.role === "broll" && b.generation_id && gens[b.generation_id]?.status === "completed").length;
  const clipCount = beats.filter((b) => b.role === "broll" && b.video_generation_id && gens[b.video_generation_id]?.status === "completed").length;
  const brollClipCount = beats.filter((b) => b.role === "broll" && b.overlay_enabled !== false && b.video_generation_id && gens[b.video_generation_id]?.status === "completed").length;
  const avatarPromptCount = chunks.filter((c) => (c.video_prompt?.trim().length ?? 0) >= MIN_AVATAR_PROMPT_CHARS).length;
  const avatarClipCount = chunks.filter((c) => c.generation_id && gens[c.generation_id]?.status === "completed").length;
  const avatarTotalSeconds = chunks.reduce((s, c) => s + avatarDurationOf(c), 0);
  const avatarTotalCost = (() => {
    const costs = chunks.map((c) => avatarClipCost(avatarDurationOf(c)));
    return costs.length && costs.every((c) => c != null) ? costs.reduce((s, c) => s + (c ?? 0), 0) : null;
  })();

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
            {splitting ? (redoNote.trim() && beats.length ? "Redoing the board…" : "Splitting with Claude…") : beats.length ? (redoNote.trim() ? "Redo the whole board" : "Re-split into beats") : "Split into beats"}
          </Button>
          {beats.length && canEdit ? (
            <div className="mt-2 rounded-[6px] border border-hairline p-2">
              <Label className="mb-1">Board came out wrong? Say why</Label>
              <Textarea
                value={redoNote}
                onChange={(e) => changeRedoNote(e.target.value)}
                rows={4}
                placeholder="What was wrong with all of it and what you want instead. Claude throws out every prompt on this board and rewrites them all with this as its top instruction."
                className="font-sans text-[12px]"
              />
              <label className="mt-1.5 flex cursor-pointer items-start gap-2 text-[11px] text-cream-2">
                <input type="checkbox" className="mt-0.5" checked={redoRemember} onChange={(e) => setRedoRemember(e.target.checked)} />
                <span>Remember this for every future board and reprompt</span>
              </label>
            </div>
          ) : null}
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
                  {videoOptionLabel(m, board.video_duration, board.video_resolution)}
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
          {brollClipTotal != null && brollBeats.length ? (
            <p className="text-[11px] text-muted">
              All {brollBeats.length} B-roll clips: about <span className="text-cream">{formatUsd(brollClipTotal)}</span>, one take each
            </p>
          ) : null}
        </div>
      </aside>

      {/* ─── right: beats ─── */}
      <section className="min-w-0">
        <div className="mb-4 flex items-center gap-3 border-b border-hairline pb-3">
          <Segmented<"board" | "avatar">
            value={tab}
            onChange={setTab}
            aria-label="Phase"
            options={[
              { value: "board", label: `Storyboard · ${brollCount} B-roll` },
              { value: "avatar", label: `Avatar · ${chunks.length} chunks` },
            ]}
          />
          <div className="ml-auto">
            <CostBreakdown boardId={initial.id} refreshKey={Object.keys(gens).length} />
          </div>
          {(() => {
            const s = tab === "avatar" ? chunkSave : saveState;
            return (
              <span className={cn("flex items-center gap-1 text-[11px]", s === "saved" ? "text-muted" : "text-gold")}>
                {s === "saving" ? <Loader2 className="size-3 animate-spin" /> : s === "saved" ? <Check className="size-3" /> : null}
                {s === "saving" ? "Saving" : s === "saved" ? "Saved" : "Unsaved"}
              </span>
            );
          })()}
        </div>

        {tab === "avatar" ? (
          <div className="space-y-4">
            <div className="grid gap-4 rounded-[8px] border border-hairline bg-surface p-3 md:grid-cols-[150px_1fr]">
              <RefSlot
                label="Avatar still"
                hint={!board.avatar_media_id && subject?.media ? "using the subject's base image" : undefined}
                media={avatarMedia}
                userId={profile.id}
                disabled={!canEdit}
                onChange={(m) => {
                  if (m) setMedia((cur) => ({ ...cur, [m.id]: m }));
                  void patchBoard({ avatar_media_id: m?.id ?? null });
                }}
              />
              <div className="space-y-3">
                <p className="text-[12px] leading-snug text-cream-2">
                  Every chunk of the script is animated from this one still, speaking its line with generated voice. Keep the same still (same room, same framing) for the whole board so the clips cut together. A 9:16 phone-style frame with her already looking into the lens works best.
                </p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <Label className="mb-1.5">Avatar model</Label>
                    <NativeSelect value={avatarModelId} disabled={!canEdit} onChange={(e) => void patchBoard({ avatar_model: e.target.value, avatar_resolution: null })}>
                      {avatarModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.tier ? `${m.name} ${m.tier}` : m.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  {avatarModel.options.resolutions ? (
                    <div>
                      <Label className="mb-1.5">Quality</Label>
                      <Segmented size="sm" value={avatarResolution} options={avatarModel.options.resolutions.map((v) => ({ value: v }))} onChange={(v) => canEdit && void patchBoard({ avatar_resolution: v })} />
                    </div>
                  ) : null}
                  <div>
                    <Label className="mb-1.5">Clip lengths</Label>
                    <p className="text-[12px] text-cream">{avatarDurations.map((d) => `${d}s`).join(" / ")}</p>
                    <p className="text-[11px] text-muted">picked per chunk from its speaking time{avatarClipCost(avatarDurations[avatarDurations.length - 1]) != null ? ` · up to ${formatUsd(avatarClipCost(avatarDurations[avatarDurations.length - 1])!)} a clip` : ""}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-cream-2">
                {chunks.length} chunks{chunks.length ? ` · ${avatarTotalSeconds}s of talking head` : ""} · {avatarPromptCount} prompts · {avatarClipCount} clips{avatarTotalCost != null && chunks.length ? ` · about ${formatUsd(avatarTotalCost)} for the full set` : ""}
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" disabled={!canEdit || chunking || (!board.script.trim() && !beats.length)} onClick={() => void chunkScript()} title={`Cut the whole script into as few clips as possible, each one ${Math.max(...avatarDurations)}s or shorter at quick UGC pace`}>
                  {chunking ? <Loader2 className="animate-spin" /> : <Scissors />} {chunking ? "Chunking…" : chunks.length ? "Re-chunk script" : "Chunk script"}
                </Button>
                <Button variant="outline" size="sm" disabled={!canEdit || writingAvatar || !chunks.length || !avatarReady} onClick={() => void writeAvatarPrompts("missing")} title="Write a talking-head prompt for every chunk that has none yet">
                  {writingAvatar ? <Loader2 className="animate-spin" /> : <Wand2 />} {writingAvatar ? "Writing…" : "Write avatar prompts"}
                </Button>
                <Button variant="ghost" size="sm" disabled={!canEdit || writingAvatar || !avatarPromptCount} onClick={() => void writeAvatarPrompts("all")} title="Rewrite every chunk's prompt">
                  Rewrite all
                </Button>
                {runAll ? (
                  <>
                    <RunProgress done={runAll.done} total={runAll.total} inFlight={Math.min(concurrency, runAll.total - runAll.done)} />
                    <Button variant="danger" size="sm" onClick={() => (stopRef.current = true)}>
                      <Square /> Stop
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="mx-1 h-5 w-px bg-hairline" />
                    <Button variant="outline" size="sm" disabled={!canEdit || !avatarClipCount} onClick={() => void animateAvatarAll("all")}>
                      <RotateCw /> Regenerate all
                    </Button>
                    <Button variant="gold" size="sm" disabled={!canEdit || !avatarPromptCount || !avatarReady} onClick={() => void animateAvatarAll("missing")}>
                      <UserRound /> Generate missing clips
                    </Button>
                    <span className="mx-1 h-5 w-px bg-hairline" />
                    <Button
                      variant={board.avatar_assembly ? "outline" : "gold"}
                      size="sm"
                      disabled={!canEdit || assembling || !chunks.length || avatarClipCount < chunks.length}
                      title={avatarClipCount < chunks.length ? `${chunks.length - avatarClipCount} chunk${chunks.length - avatarClipCount === 1 ? "" : "s"} still need a clip` : "Join every clip in order into one talking-head track: hard cuts, no gaps, the held pose after each line trimmed off"}
                      onClick={() => void assembleAroll()}
                    >
                      {assembling ? <Loader2 className="animate-spin" /> : <Film />} {assembling ? "Assembling…" : board.avatar_assembly ? "Re-assemble A-roll" : "Assemble A-roll"}
                    </Button>
                  </>
                )}
              </div>
            </div>

            {chunks.length === 0 ? (
              <div className="rounded-[8px] border border-dashed border-hairline px-6 py-16 text-center">
                <p className="font-serif text-xl text-cream">No chunks yet</p>
                <p className="mt-2 text-sm text-cream-2">Press Chunk script. The whole script is packed into as few clips as possible, in order, at quick UGC pace. The storyboard beats are untouched.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {chunks.map((chunk, index) => (
                  <AvatarCard
                    key={chunk.id}
                    chunk={chunk}
                    index={index}
                    model={avatarModel}
                    generation={chunk.generation_id ? (gens[chunk.generation_id] ?? null) : null}
                    animating={animating.has(chunk.id)}
                    avatarReady={avatarReady}
                    userId={profile.id}
                    canEdit={canEdit}
                    onPatch={(p) => patchChunk(chunk.id, p)}
                    onAnimate={() => void animateChunk(chunk.id)}
                    onReprompt={(direction, examples, fresh) => repromptChunk(chunk.id, direction, examples, fresh)}
                    onShowGeneration={(id) => void showChunkGeneration(chunk.id, id)}
                    onDeleteTake={(id) => deleteChunkTake(chunk.id, id)}
                    onFeedback={(id, tag, note) => feedback("chunk", chunk.id, id, tag, note)}
                    onApprove={(id, on) => approve("chunk", chunk.id, id, on)}
                    approved={approved}
                  />
                ))}
              </div>
            )}
            {board.avatar_assembly ? (
              <div className="grid gap-4 rounded-[8px] border border-gold/40 bg-surface p-3 md:grid-cols-[220px_1fr]" id="aroll-assembly">
                <div className="relative aspect-[9/16] overflow-hidden rounded-[6px] bg-black">
                  <video key={board.avatar_assembly.url} src={board.avatar_assembly.url} controls playsInline preload="metadata" className="h-full w-full object-contain" />
                </div>
                <div className="min-w-0 space-y-2">
                  <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.08em] text-gold">
                    <Film className="size-3" /> A-roll track
                  </div>
                  <p className="text-sm text-cream">
                    {board.avatar_assembly.duration_s}s · {board.avatar_assembly.chunk_ids.length} clips · assembled {new Date(board.avatar_assembly.created_at).toLocaleString()}
                  </p>
                  <p className="text-[11px] leading-snug text-cream-2">
                    Hard cuts, no gaps. Each clip is cut from just before her first word to just after her last (word timestamps), so breaths and held poses go; the trims below show what came off. This track is what the B-roll gets laid over next.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {board.avatar_assembly.trims.map((t, i) => (
                      <span key={t.chunk_id} className="rounded-[4px] border border-hairline px-1.5 py-0.5 font-mono text-[10px] text-muted" title={`chunk #${i + 1}: kept ${(t.cut_s - (t.head_s ?? 0)).toFixed(2)}s of ${t.source_s}s (${(t.head_s ?? 0).toFixed(2)}s off the head, ${(t.source_s - t.cut_s).toFixed(2)}s off the tail)`}>
                        #{i + 1} {(t.cut_s - (t.head_s ?? 0)).toFixed(1)}s{t.source_s - (t.cut_s - (t.head_s ?? 0)) > 0.05 ? ` (−${(t.source_s - (t.cut_s - (t.head_s ?? 0))).toFixed(1)})` : ""}
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button variant="outline" size="sm" onClick={() => void downloadFile(board.avatar_assembly!.url, `${board.title.replace(/[^\w-]+/g, "_") || "board"}-aroll.mp4`)}>
                      <Download /> Download A-roll
                    </Button>
                  </div>
                  <EditNotes boardId={initial.id} target="aroll" canEdit={canEdit} isAdmin={profile.role === "admin"} />
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-muted">Once every chunk has a clip, Assemble A-roll joins them in order into one talking-head track. The B-roll is then laid over that track.</p>
            )}

            {board.avatar_assembly ? (
              <div className="rounded-[8px] border border-hairline bg-surface p-3" id="final-assembly">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.08em] text-cream-2">
                    <Layers className="size-3" /> Finished ad
                  </div>
                  <span className="text-[11px] text-muted">
                    {brollClipCount} B-roll clip{brollClipCount === 1 ? "" : "s"} ready of {brollCount}
                    {board.avatar_assembly.words?.length ? " · A-roll transcribed" : " · A-roll not transcribed yet"}
                  </span>
                  <Button variant={board.final_assembly ? "outline" : "gold"} size="sm" className="ml-auto" disabled={!canEdit || assemblingFinal || !brollClipCount} onClick={() => void assembleFinal()} title="Lay every B-roll clip over the A-roll where its line is spoken. Clips shorter than their line cut back to her; beats without a clip are skipped.">
                    {assemblingFinal ? <Loader2 className="animate-spin" /> : <Layers />} {assemblingFinal ? "Cutting…" : board.final_assembly ? "Re-cut B-roll in" : "Cut B-roll in"}
                  </Button>
                </div>
                {board.final_assembly ? (
                  <div className="mt-3 grid gap-4 md:grid-cols-[220px_1fr]">
                    <div className="relative aspect-[9/16] overflow-hidden rounded-[6px] bg-black">
                      <video key={board.final_assembly.url} src={board.final_assembly.url} controls playsInline preload="metadata" className="h-full w-full object-contain" />
                    </div>
                    <div className="min-w-0 space-y-2">
                      <p className="text-sm text-cream">
                        {board.final_assembly.duration_s}s · {board.final_assembly.placements.length} B-roll placed{board.final_assembly.skipped.length ? ` · ${board.final_assembly.skipped.length} skipped` : ""} · {new Date(board.final_assembly.created_at).toLocaleString()}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {board.final_assembly.placements.map((pl) => {
                          const idx = beats.findIndex((b) => b.id === pl.beat_id);
                          return (
                            <span key={pl.beat_id} className="rounded-[4px] border border-hairline px-1.5 py-0.5 font-mono text-[10px] text-muted" title={`beat #${idx + 1}: ${pl.start_s}s to ${pl.end_s}s (from ${pl.in_s}s into the clip, line match ${Math.round(pl.score * 100)}%)`}>
                              #{idx + 1} {pl.start_s}–{pl.end_s}s
                            </span>
                          );
                        })}
                        {board.final_assembly.skipped.map((sk) => {
                          const idx = beats.findIndex((b) => b.id === sk.beat_id);
                          return (
                            <span key={sk.beat_id} className="rounded-[4px] border border-danger/40 px-1.5 py-0.5 font-mono text-[10px] text-danger" title={sk.reason}>
                              #{idx + 1} skipped
                            </span>
                          );
                        })}
                      </div>
                      <div className="flex gap-2 pt-1">
                        <Button variant="outline" size="sm" onClick={() => void downloadFile(board.final_assembly!.url, `${board.title.replace(/[^\w-]+/g, "_") || "board"}-final.mp4`)}>
                          <Download /> Download finished ad
                        </Button>
                      </div>
                      <EditNotes boardId={initial.id} target="final" canEdit={canEdit} isAdmin={profile.role === "admin"} />
                      <CaptionsPanel boardId={initial.id} initial={board.captions ?? null} canEdit={canEdit} canRender={!!board.avatar_assembly?.words?.length} title={board.title} />
                    </div>
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] text-muted">Each B-roll beat&apos;s line is found in the A-roll transcript and its clip is laid over exactly that stretch, her audio underneath. Set a start point or a cap per beat in the Storyboard tab if a clip&apos;s best part isn&apos;t at the top.</p>
                )}
              </div>
            ) : null}
          </div>
        ) : (
          <>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 className="font-serif text-2xl text-cream">Beats</h2>
          <span className="text-xs text-cream-2">
            {beats.length} total · {brollCount} B-roll · {doneCount} images · {clipCount} clips
          </span>
          <div className="ml-auto flex items-center gap-2">
            {runAll ? (
              <>
                <RunProgress done={runAll.done} total={runAll.total} inFlight={Math.min(concurrency, runAll.total - runAll.done)} />
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
                onReprompt={(direction, attach, examples, fresh) => reprompt(beat.id, direction, attach, examples, fresh)}
                onShowGeneration={(id) => void showGeneration(beat.id, id)}
                onAnimate={() => void animate(beat.id)}
                onRepromptVideo={(direction, attach, examples, fresh) => repromptVideo(beat.id, direction, attach, examples, fresh)}
                onShowVideoGeneration={(id) => void showGeneration(beat.id, id, "video")}
                onDeleteTake={(id) => deleteTake(beat.id, id)}
                onUploadTake={(m) => uploadTake(beat.id, m)}
                onFeedback={(kind, id, tag, note) => feedback(kind === "image" ? "beat_image" : "beat_video", beat.id, id, tag, note)}
                onApprove={(kind, id, on) => approve(kind === "image" ? "beat_image" : "beat_video", beat.id, id, on)}
                approved={approved}
              />
            ))}
          </div>
        )}
          </>
        )}
      </section>
    </div>
  );
}

import type { ApiGeneration } from "@/lib/client-api";

export type Role = "admin" | "editor";

export type Profile = {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  avatar_url: string | null;
  is_bot: boolean;
  created_at: string;
};

export type GenerationStatus = "queued" | "processing" | "completed" | "failed";
export type MediaType = "video" | "image" | "audio";

export type Generation = {
  id: string;
  user_id: string;
  batch_id: string | null;
  provider: "kie" | "google" | "fal" | "elevenlabs";
  provider_request_id: string | null;
  provider_endpoint: string | null;
  model: string;
  model_display_name: string;
  media_type: MediaType;
  status: GenerationStatus;
  params: GenerationParams;
  prompt: string | null;
  result_url: string | null;
  result_storage_path: string | null;
  result_metadata: Record<string, unknown> | null;
  estimated_cost_usd: number | null;
  cost_usd: number | null;
  duration_seconds: number | null;
  resolution: string | null;
  aspect_ratio: string | null;
  error_message: string | null;
  is_shared: boolean;
  source: "web" | "api";
  api_key_id: string | null;
  /** Set when the primary provider failed/stalled and the job re-ran on the backup. */
  fallback_reason: string | null;
  fallback_at: string | null;
  finalizing_at: string | null;
  last_polled_at: string | null;
  created_at: string;
  completed_at: string | null;
};

/** A generation joined with its author, as returned by the API. */
export type GenerationWithUser = Generation & {
  user: Pick<Profile, "id" | "display_name" | "avatar_url" | "is_bot"> | null;
};

/** Kling 3.0 element: a named subject (2–4 images) referenced in the prompt as @name. */
export type ReferenceElement = { name: string; description?: string; image_urls: string[] };

/** Normalized, provider-agnostic generation parameters. */
export type GenerationParams = {
  prompt?: string;
  negative_prompt?: string;
  /** Image models: reference images. Video models (legacy/API alias): [start frame, end frame]. */
  image_urls?: string[];
  image_url?: string;
  end_image_url?: string;
  /** Video models: first and last frame. */
  start_frame_url?: string;
  end_frame_url?: string;
  /** Video models: multimodal references (mutually exclusive with frames on most models). */
  reference_image_urls?: string[];
  reference_video_urls?: string[];
  reference_audio_urls?: string[];
  /** Seconds per reference clip, same order as the URLs — used for limits and trimming. */
  reference_video_durations?: number[];
  reference_audio_durations?: number[];
  elements?: ReferenceElement[];
  audio_url?: string;
  video_url?: string;
  aspect_ratio?: string;
  duration?: number;
  resolution?: string;
  quality?: string;
  seed?: number;
  generate_audio?: boolean;
  /** Filled in by the client from the uploaded audio file; used for avatar cost estimates. */
  audio_duration_seconds?: number;
  /** Filled in by the client for video upscalers; used for the cost estimate. */
  source_video_duration_seconds?: number;
  /** Model-specific settings declared in the model's `options.fields` (song style, voice, …). */
  settings?: Record<string, string | number | boolean>;
  /** Escape hatch: raw provider fields merged into the provider request last. */
  extra?: Record<string, unknown>;
};

export type Media = {
  id: string;
  user_id: string;
  type: MediaType;
  filename: string;
  storage_path: string;
  url: string;
  file_size_bytes: number | null;
  metadata: { width?: number; height?: number; duration_seconds?: number; mime_type?: string } | null;
  generation_id: string | null;
  /** Imported B-roll: source folder name, folder + filename words, and the original path on disk. */
  folder?: string | null;
  tags?: string[];
  source_path?: string | null;
  created_at: string;
};

// ─── B-roll Starter Image Board ──────────────────────────────────────────────

export type Subject = {
  id: string;
  user_id: string;
  name: string;
  media_id: string | null;
  base_prompt: string;
  is_default: boolean;
  created_at: string;
  /** Joined base image. */
  media?: Media | null;
};

export type BeatRole = "aroll" | "broll";

export type ReferencePlan = {
  subject_lock?: boolean;
  pose_ref?: string;
  setting_ref?: string;
  mode?: "new" | "reuse" | "edit" | string;
  library_asset?: string;
  edit_note?: string;
};

export type Beat = {
  id: string;
  board_id: string;
  position: number;
  role: BeatRole;
  vo: string;
  shot_type: string | null;
  style: string | null;
  image_prompt: string;
  video_prompt: string | null;
  negative_prompt: string | null;
  reference_plan: ReferencePlan | null;
  use_subject_lock: boolean;
  pose_media_id: string | null;
  setting_media_id: string | null;
  /** Extra reference images after the fixed slots, in order. */
  extra_media_ids: string[];
  generation_id: string | null;
  generation_ids: string[];
  /** Per-beat clip overrides; null = use the board's defaults. */
  video_model: string | null;
  video_duration: number | null;
  video_resolution: string | null;
  /** B-roll overlay: include this beat, where in its clip to start, and how long to show at most. */
  overlay_enabled: boolean;
  overlay_in: number;
  overlay_max: number | null;
  video_generation_id: string | null;
  video_generation_ids: string[];
  created_at: string;
};

export type Board = {
  id: string;
  user_id: string;
  title: string;
  script: string;
  subject_id: string | null;
  model: string;
  aspect_ratio: string;
  resolution: string;
  /** Defaults for the video phase. */
  video_model: string;
  video_duration: number;
  video_resolution: string | null;
  /** Avatar phase: the still every A-roll clip is animated from (else the subject's base image), and its model/quality. */
  avatar_media_id: string | null;
  avatar_model: string;
  avatar_resolution: string | null;
  /** The assembled talking-head track: every chunk clip joined in order, tails trimmed. */
  avatar_assembly: AvatarAssembly | null;
  final_assembly: FinalAssembly | null;
  brain_output: { subject_lock?: string; style_locks?: Record<string, string> } | null;
  created_at: string;
  updated_at: string;
};

export type AvatarAssembly = {
  url: string;
  path: string;
  duration_s: number;
  chunk_ids: string[];
  /** Where each clip was cut (seconds into the clip) so the held pose after the line is dropped. */
  trims: { chunk_id: string; cut_s: number; source_s: number; head_s?: number }[];
  /** Word timestamps from speech-to-text on this track (cached; the overlay and captions use them). */
  words?: TranscriptWord[];
  created_at: string;
};

export type TranscriptWord = { text: string; start: number; end: number };

/** A note the editor left on an assembled output (A-roll track or finished ad). */
export type EditNote = { id: string; target_type: "aroll" | "final"; note: string; at_s: number | null; created_at: string; user_id: string | null };

/** The finished ad: B-roll laid over the A-roll track. */
export type FinalAssembly = {
  url: string;
  path: string;
  duration_s: number;
  placements: { beat_id: string; generation_id: string; start_s: number; end_s: number; in_s: number; score: number }[];
  skipped: { beat_id: string; reason: string }[];
  created_at: string;
};

/** One clip-sized piece of the script the avatar speaks. Its own list, independent of the storyboard beats. */
export type AvatarChunk = {
  id: string;
  board_id: string;
  position: number;
  vo: string;
  /** Clip length in seconds; null = auto from the word count. */
  duration: number | null;
  video_prompt: string | null;
  generation_id: string | null;
  generation_ids: string[];
  created_at: string;
};

/** A board as the editor loads it: beats in order plus every media row and generation they point at. */
export type BoardWithBeats = Board & {
  subject: Subject | null;
  beats: Beat[];
  avatar_chunks: AvatarChunk[];
  media: Record<string, Media>;
  /** Serialized like the REST API (see serializeGeneration): `error` instead of `error_message`. */
  generations: Record<string, ApiGeneration>;
};

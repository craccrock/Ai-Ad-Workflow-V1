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
  created_at: string;
};

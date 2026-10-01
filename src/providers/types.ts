import type { InputType, ModelConfig, NormalizedParams } from "@/config/models.config";

/** One output file from a provider — either a fetchable URL or inline bytes. */
export type ProviderFile = {
  url?: string;
  /** Extra headers needed to fetch `url` (e.g. Google file URIs need the API key). */
  fetchHeaders?: Record<string, string>;
  data?: Buffer;
  mimeType: string;
  width?: number;
  height?: number;
};

export type ProviderOutput = {
  files: ProviderFile[];
  usage: { costUsd?: number; videoOutputTokens?: number; outputDurationSeconds?: number };
  metadata?: Record<string, unknown>;
};

/**
 * Normalized provider state. Every provider maps into this so the rest of the app
 * (UI, API, DB) only ever sees queued → processing → completed | failed.
 */
export type ProviderState =
  | { status: "queued" | "processing"; requestId: string; endpoint: string }
  | { status: "completed"; output: ProviderOutput; requestId?: string; endpoint: string }
  | { status: "failed"; error: string; requestId?: string; endpoint: string };

export type StartContext = {
  mode: InputType;
  /** Public URL the provider should POST to when a job finishes (optional). */
  webhookUrl?: string;
};

export interface ProviderAdapter {
  /** Kick off a generation. May complete synchronously (Google images) or return a request id. */
  start(model: ModelConfig, params: NormalizedParams, ctx: StartContext): Promise<ProviderState>;
  /** Check an in-flight request. */
  poll(model: ModelConfig, requestId: string, endpoint: string): Promise<ProviderState>;
}

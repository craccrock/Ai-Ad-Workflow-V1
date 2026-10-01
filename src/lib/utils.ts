import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatUsd(value: number | null | undefined, opts: { precise?: boolean } = {}) {
  if (value == null || Number.isNaN(value)) return "—";
  // Sub-dollar amounts keep a third decimal when it matters ($0.134, not $0.13)
  if (value > 0 && value < 1 && (opts.precise || Math.round(value * 1000) % 10 !== 0)) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function truncate(text: string | null | undefined, max: number) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

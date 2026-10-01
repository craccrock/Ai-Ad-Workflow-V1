import type { ModelConfig } from "@/config/models.config";

const money = (n: number) => `$${n < 1 ? n.toFixed(4).replace(/0+$/, "").replace(/\.(\d)$/, ".$10") : n.toFixed(2)}`;

/** Short price label for model cards, e.g. "from $0.034/s" or "$0.134/image". */
export function priceLabel(model: ModelConfig): string {
  const p = model.pricing;
  if (p.unit === "flat") return `~${money(p.amount)}/run`;
  if (p.unit === "per_1k_chars") return `${money(Math.min(...Object.values(p.rates)))}/1k chars`;
  const values = Object.values(p.rates);
  const min = Math.min(...values);
  const prefix = values.length > 1 ? "from " : "";
  if (p.unit === "per_video") {
    // Show a per-second equivalent so per-clip models compare fairly with per-second ones.
    const perSecond = Object.entries(p.rates).map(([key, rate]) => rate / (Number(key.split("|")[1]) || 1));
    return `from ${money(Math.min(...perSecond))}/s`;
  }
  return p.unit === "per_second" ? `${prefix}${money(min)}/s` : `${prefix}${money(min)}/image`;
}

export const inputTypeLabels: Record<string, string> = {
  "text-to-video": "Text → Video",
  "image-to-video": "Image → Video",
  "audio-to-video": "Image + Audio → Video",
  "text-to-image": "Text → Image",
  "image-edit": "Image Edit",
  "image-upscale": "Image Upscale",
  "video-upscale": "Video Upscale",
  "text-to-music": "Text → Song",
  "text-to-speech": "Text → Voice",
  "text-to-dialogue": "Script → Dialogue",
};

/**
 * Local smoke test: renders the first N seconds of a finished ad with captions from its cached word timestamps.
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx src/test-render.ts <boardId> [preset] [seconds] [out.mp4]
 */
import { createClient } from "@supabase/supabase-js";
import { writeFile } from "node:fs/promises";
import { renderCaptions } from "./render";
import type { PresetId } from "./remotion/pages";

const [boardId, preset = "capcut", seconds = "8", out = `test-${preset}.mp4`] = process.argv.slice(2);
if (!boardId) throw new Error("usage: tsx src/test-render.ts <boardId> [preset] [seconds] [out]");
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const { data } = await supabase.from("boards").select("final_assembly, avatar_assembly").eq("id", boardId).single();
const src = (data?.final_assembly as { url?: string } | null)?.url ?? (data?.avatar_assembly as { url?: string } | null)?.url;
const words = (data?.avatar_assembly as { words?: { text: string; start: number; end: number }[] } | null)?.words ?? [];
if (!src || !words.length) throw new Error("board has no finished ad / transcript");
console.time("render");
const r = await renderCaptions({ src, words, preset: preset as PresetId, maxSeconds: Number(seconds), onProgress: (p) => process.stdout.write(`\r${Math.round(p * 100)}%  `) });
console.timeEnd("render");
await writeFile(out, r.bytes);
console.log(`\nwrote ${out} (${(r.bytes.byteLength / 1048576).toFixed(1)} MB, ${r.width}x${r.height}, ${r.durationS}s)`);

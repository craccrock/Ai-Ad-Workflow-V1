/**
 * Re-copies generated images whose stored file is truncated (a stalled provider CDN plus a copy
 * step that didn't check completeness). Kie keeps its own files ~14 days, so anything newer than
 * that can be fetched again. Run: node --env-file=.env.local scripts/repair-truncated.mjs [--apply]
 */
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 0);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const complete = (buf) =>
  buf.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    ? buf.subarray(-12).includes(Buffer.from("IEND"))
    : buf.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
      ? buf.subarray(-2).equals(Buffer.from("ffd9", "hex"))
      : true;

const get = async (url, timeout = 60000) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const expected = Number(res.headers.get("content-length") ?? 0);
  if (expected && buf.byteLength !== expected) throw new Error(`short read ${buf.byteLength}/${expected}`);
  if (!complete(buf)) throw new Error(`truncated (${buf.byteLength} bytes, no end marker)`);
  return buf;
};

// Default to the last 24 hours; --hours=N widens it (Kie keeps its own files ~14 days).
const HOURS = Number(process.argv.find((a) => a.startsWith("--hours="))?.split("=")[1] ?? 24);
const since = new Date(Date.now() - HOURS * 3600e3).toISOString();
// PostgREST caps a response at 1,000 rows, so page through the lot.
const data = [];
for (let page = 0; ; page++) {
  const { data: rows, error } = await sb.from("generations")
    .select("id,created_at,model,result_url,result_storage_path,result_metadata,user_id,provider_request_id,provider")
    .eq("status", "completed").eq("media_type", "image").gte("created_at", since).not("result_url", "is", null)
    .order("created_at", { ascending: false })
    .range(page * 1000, page * 1000 + 999);
  if (error) throw error;
  data.push(...(rows ?? []));
  if ((rows?.length ?? 0) < 1000) break;
}

const broken = [];
const queue = [...data];
await Promise.all(Array.from({ length: 8 }, async () => {
  while (queue.length) {
    const g = queue.shift();
    try {
      const r = await fetch(g.result_url, { headers: { Range: "bytes=-16" }, signal: AbortSignal.timeout(20000) });
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.includes(Buffer.from("IEND")) && !buf.subarray(-2).equals(Buffer.from("ffd9", "hex"))) broken.push(g);
    } catch { /* unreachable: leave it alone */ }
  }
}));
console.log(`${data.length} stored images checked → ${broken.length} truncated`);
if (!APPLY) console.log("(dry run — pass --apply to repair)");

const work = LIMIT ? broken.slice(0, LIMIT) : broken;
let fixed = 0, unrecoverable = 0;
for (const g of work) {
  let source = null;
  if (g.provider === "kie" && g.provider_request_id) {
    try {
      const rec = await (await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${g.provider_request_id}`, { headers: { Authorization: `Bearer ${process.env.KIE_API_KEY}` } })).json();
      source = JSON.parse(rec.data?.resultJson ?? "{}").resultUrls?.[0] ?? null;
    } catch { /* fall through */ }
  }
  if (!source) { unrecoverable++; console.log("  no source:", g.id.slice(0, 8), g.model); continue; }

  let buf = null;
  for (let attempt = 1; attempt <= 3 && !buf; attempt++) {
    try { buf = await get(source); } catch (err) { if (attempt === 3) console.log("  failed:", g.id.slice(0, 8), g.model, String(err.message).slice(0, 60)); else await new Promise((r) => setTimeout(r, attempt * 2000)); }
  }
  if (!buf) { unrecoverable++; continue; }
  if (!APPLY) { fixed++; continue; }

  const path = g.result_storage_path || `${g.user_id}/${g.id}.png`;
  const up = await sb.storage.from("generations").upload(path, buf, { contentType: "image/png", upsert: true, cacheControl: "31536000" });
  if (up.error) { console.log("  upload failed:", g.id.slice(0, 8), up.error.message); unrecoverable++; continue; }
  const { data: pub } = sb.storage.from("generations").getPublicUrl(path);
  await sb.from("generations").update({
    result_url: pub.publicUrl, result_storage_path: path,
    result_metadata: { ...(g.result_metadata ?? {}), file_size_bytes: buf.byteLength, repaired_at: new Date().toISOString() },
  }).eq("id", g.id);
  await sb.from("media").update({ url: pub.publicUrl, file_size_bytes: buf.byteLength }).eq("generation_id", g.id);
  fixed++;
  if (fixed % 25 === 0) console.log(`  …${fixed} repaired`);
}
console.log(APPLY ? `repaired ${fixed}, unrecoverable ${unrecoverable}` : `${fixed} of ${work.length} could be re-fetched now, ${unrecoverable} could not`);

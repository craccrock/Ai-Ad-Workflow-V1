/**
 * Completed jobs whose file never made it into our storage still point at the provider's own host,
 * which is exactly the host that was too slow to copy from. This re-copies them once it's healthy.
 * Run: node --env-file=.env.local scripts/recopy-provider-urls.mjs [--days=3]
 */
import { createClient } from "@supabase/supabase-js";

const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 3);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

/** Returns the media type when the bytes are a whole file, else null. */
function wholeFile(buf) {
  if (buf.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return buf.subarray(-12).includes(Buffer.from("IEND")) ? "image/png" : null;
  if (buf.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return buf.subarray(-2).equals(Buffer.from("ffd9", "hex")) ? "image/jpeg" : null;
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return buf.readUInt32LE(4) + 8 === buf.byteLength ? "image/webp" : null;
  if (buf.subarray(4, 8).toString("latin1") === "ftyp") return "video/mp4";
  if (buf.subarray(0, 3).toString("latin1") === "ID3" || buf[0] === 0xff) return "audio/mpeg";
  return buf.byteLength ? "application/octet-stream" : null;
}

const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "audio/mpeg": "mp3", "application/octet-stream": "bin" };

const since = new Date(Date.now() - DAYS * 864e5).toISOString();
const { data } = await sb.from("generations")
  .select("id,created_at,model,media_type,result_url,result_metadata,user_id")
  .eq("status", "completed").gte("created_at", since).not("result_url", "is", null);
const pending = (data ?? []).filter((g) => !g.result_url.includes("supabase.co"));
console.log(`${pending.length} job(s) still pointing at a provider URL`);

let copied = 0, stillBad = 0;
for (const g of pending) {
  let buf = null, mime = null;
  for (let attempt = 1; attempt <= 4 && !mime; attempt++) {
    try {
      const res = await fetch(g.result_url, { signal: AbortSignal.timeout(90000) });
      if (!res.ok) throw new Error(`http ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
      const expected = Number(res.headers.get("content-length") ?? 0);
      mime = expected && buf.byteLength !== expected ? null : wholeFile(buf);
      if (!mime && attempt < 4) await new Promise((r) => setTimeout(r, attempt * 3000));
    } catch {
      if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  if (!mime) { stillBad++; console.log("  provider still won't serve it whole:", g.id.slice(0, 8), g.model); continue; }

  const path = `${g.user_id}/${g.id}.${ext[mime] ?? "bin"}`;
  const up = await sb.storage.from("generations").upload(path, buf, { contentType: mime, upsert: true, cacheControl: "31536000" });
  if (up.error) { stillBad++; console.log("  upload failed:", g.id.slice(0, 8), up.error.message); continue; }
  const { data: pub } = sb.storage.from("generations").getPublicUrl(path);
  const meta = { ...(g.result_metadata ?? {}), mime_type: mime, file_size_bytes: buf.byteLength, recopied_at: new Date().toISOString() };
  delete meta.provider_url_only;
  await sb.from("generations").update({ result_url: pub.publicUrl, result_storage_path: path, result_metadata: meta }).eq("id", g.id);
  await sb.from("media").update({ url: pub.publicUrl, storage_path: path, file_size_bytes: buf.byteLength }).eq("generation_id", g.id);
  copied++;
  console.log("  copied", g.id.slice(0, 8), g.model, (buf.byteLength / 1024 / 1024).toFixed(1) + " MB", mime);
}
console.log(`copied ${copied}, still unavailable ${stillBad}`);

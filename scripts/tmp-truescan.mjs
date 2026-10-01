import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

/** PNG ends with IEND, JPEG with FFD9, WebP declares its size in the RIFF header. */
function verdict(buf) {
  if (buf.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return { type: "png", ok: buf.subarray(-12).includes(Buffer.from("IEND")) };
  if (buf.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return { type: "jpeg", ok: buf.subarray(-2).equals(Buffer.from("ffd9", "hex")) };
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return { type: "webp", ok: buf.readUInt32LE(4) + 8 === buf.byteLength };
  return { type: "other", ok: true };
}

const since = new Date(Date.now() - 24 * 3600e3).toISOString();
const { data } = await sb.from("generations")
  .select("id,created_at,model,result_url,result_storage_path,result_metadata,user_id,provider,provider_request_id")
  .eq("status", "completed").eq("media_type", "image").gte("created_at", since).not("result_url", "is", null)
  .order("created_at", { ascending: false });

const broken = [], types = {};
const queue = [...data];
await Promise.all(Array.from({ length: 10 }, async () => {
  while (queue.length) {
    const g = queue.shift();
    try {
      const buf = Buffer.from(await (await fetch(g.result_url, { signal: AbortSignal.timeout(45000) })).arrayBuffer());
      const v = verdict(buf);
      types[v.type] = (types[v.type] ?? 0) + 1;
      if (!v.ok) broken.push({ ...g, bytes: buf.byteLength, type: v.type });
    } catch { types.unreachable = (types.unreachable ?? 0) + 1; }
  }
}));
console.log("today's stored images:", data.length, JSON.stringify(types));
console.log("genuinely truncated:", broken.length);
const byModel = {};
for (const b of broken) byModel[b.model] = (byModel[b.model] ?? 0) + 1;
console.log(byModel);
await import("node:fs").then((fs) => fs.writeFileSync("/tmp/broken.json", JSON.stringify(broken)));

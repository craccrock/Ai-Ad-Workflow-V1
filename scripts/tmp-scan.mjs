import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const since = new Date(Date.now() - 4 * 864e5).toISOString();
const { data, error } = await sb.from("generations")
  .select("id,created_at,model,media_type,result_url,result_storage_path,result_metadata,user_id,provider_request_id")
  .eq("status", "completed").eq("media_type", "image").gte("created_at", since).not("result_url", "is", null);
if (error) throw error;
console.log("checking", data.length, "stored images from the last 4 days…");

const tail = async (url) => {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers: { Range: "bytes=-16" }, signal: AbortSignal.timeout(20000) });
      if (!r.ok && r.status !== 206) return { err: `http ${r.status}` };
      return { buf: Buffer.from(await r.arrayBuffer()) };
    } catch (e) { if (i) return { err: String(e).slice(0, 60) }; }
  }
  return { err: "unreachable" };
};

const broken = [];
let checked = 0, errors = 0;
const queue = [...data];
await Promise.all(Array.from({ length: 8 }, async () => {
  while (queue.length) {
    const g = queue.shift();
    const { buf, err } = await tail(g.result_url);
    if (err) { errors++; continue; }
    checked++;
    const complete = buf.includes(Buffer.from("IEND")) || buf.subarray(-2).equals(Buffer.from("ffd9", "hex"));
    if (!complete) broken.push(g);
  }
}));
console.log(`checked ${checked}, unreachable ${errors}, TRUNCATED ${broken.length}`);
for (const g of broken.slice(0, 12)) console.log("  ", g.created_at.slice(5, 16), g.model, ((g.result_metadata?.file_size_bytes ?? 0) / 1024).toFixed(0) + " KB", g.id.slice(0, 8));
if (broken.length) await import("node:fs").then(fs => fs.writeFileSync("/tmp/broken.json", JSON.stringify(broken)));

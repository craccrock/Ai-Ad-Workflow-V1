import { LEARNING_TAGS } from "@/config/learning-tags";
import { Badge, Card, PageHeader } from "@/components/ui/misc";
import { requireSessionProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

type Row = {
  id: string;
  board_id: string | null;
  kind: string;
  target_type: string;
  model: string | null;
  prompt: string | null;
  after_prompt: string | null;
  direction: string | null;
  tag: string | null;
  note: string | null;
  meta: Record<string, unknown>;
  created_at: string;
};

const KIND_LABEL: Record<string, string> = {
  reprompt: "Reprompt",
  reroll: "Re-roll (rejected)",
  take_delete: "Deleted take",
  take_select: "Picked take",
  thumbs_down: "Thumbs down",
  keeper: "Keeper (assembled)",
};
const KIND_TONE: Record<string, "default" | "gold" | "success" | "danger"> = { keeper: "success", take_select: "gold", reprompt: "default", reroll: "danger", take_delete: "danger", thumbs_down: "danger" };
const TARGET_LABEL: Record<string, string> = { beat_image: "B-roll image", beat_video: "B-roll clip", chunk: "Avatar clip" };

const snip = (s: string | null | undefined, n = 160) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : "");

export default async function LearningsPage() {
  await requireSessionProfile({ admin: true });
  const admin = createAdminClient();
  // eslint-disable-next-line react-hooks/purity -- server component, runs once per request
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const [{ data: recent }, { data: all }, { data: boards }] = await Promise.all([
    admin.from("learning_events").select("*").order("created_at", { ascending: false }).limit(150),
    admin.from("learning_events").select("kind, tag, target_type").gte("created_at", since),
    admin.from("boards").select("id, title"),
  ]);
  const rows = (recent ?? []) as Row[];
  const titles = new Map(((boards ?? []) as { id: string; title: string }[]).map((b) => [b.id, b.title]));
  const byKind = new Map<string, number>();
  const byTag = new Map<string, number>();
  for (const e of (all ?? []) as Pick<Row, "kind" | "tag" | "target_type">[]) {
    byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
    if (e.kind === "thumbs_down" && e.tag) byTag.set(e.tag, (byTag.get(e.tag) ?? 0) + 1);
  }
  const tagLabel = (v: string) => LEARNING_TAGS.find((t) => t.value === v)?.label ?? v;

  return (
    <>
      <PageHeader title="Learnings" subtitle="Every editorial judgment the boards record: reprompts, rejections, picks, thumbs-downs and the takes that made it into an assembled track. The prompt writers will draw on this." />

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Object.keys(KIND_LABEL).map((k) => (
          <Card key={k} className="p-3">
            <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-cream-2">{KIND_LABEL[k]}</p>
            <p className="mt-1 font-serif text-2xl text-cream">{byKind.get(k) ?? 0}</p>
            <p className="text-[10px] text-muted">last 30 days</p>
          </Card>
        ))}
      </div>

      {byTag.size ? (
        <Card className="mt-4 p-3">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.08em] text-cream-2">Why takes get thumbed down</p>
          <div className="flex flex-wrap gap-2">
            {[...byTag.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([t, n]) => (
                <span key={t} className="rounded-[6px] border border-hairline px-2 py-1 text-[12px] text-cream">
                  {tagLabel(t)} <span className="font-mono text-muted">×{n}</span>
                </span>
              ))}
          </div>
        </Card>
      ) : null}

      <Card className="mt-4 overflow-hidden">
        <div className="border-b border-hairline px-4 py-3 text-[10px] font-medium uppercase tracking-[0.08em] text-cream-2">Recent events</div>
        {rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-cream-2">Nothing logged yet. Reprompt, re-roll, pick or thumbs-down a take on any board and it shows up here.</p>
        ) : (
          <ul className="divide-y divide-hairline">
            {rows.map((e) => (
              <li key={e.id} className="grid gap-2 px-4 py-3 text-[12px] md:grid-cols-[150px_110px_1fr_140px]">
                <div className="flex flex-col gap-1">
                  <Badge tone={KIND_TONE[e.kind] ?? "default"}>{KIND_LABEL[e.kind] ?? e.kind}</Badge>
                  {e.tag ? <span className="text-[11px] text-cream-2">{tagLabel(e.tag)}</span> : null}
                </div>
                <div className="text-cream-2">
                  <div>{TARGET_LABEL[e.target_type] ?? e.target_type}</div>
                  {e.model ? <div className="font-mono text-[10px] text-muted">{e.model}</div> : null}
                </div>
                <div className="min-w-0 space-y-1 text-cream">
                  {typeof e.meta?.vo === "string" && e.meta.vo ? <p className="text-cream-2">“{snip(e.meta.vo as string, 110)}”</p> : null}
                  {e.direction ? (
                    <p>
                      <span className="text-gold">Direction:</span> {snip(e.direction, 220)}
                    </p>
                  ) : null}
                  {e.note ? (
                    <p>
                      <span className="text-gold">Note:</span> {snip(e.note, 220)}
                    </p>
                  ) : null}
                  {e.kind === "reprompt" && e.after_prompt ? <p className="text-[11px] text-muted" title={e.after_prompt}>→ {snip(e.after_prompt, 180)}</p> : e.prompt ? <p className="text-[11px] text-muted" title={e.prompt}>{snip(e.prompt, 180)}</p> : null}
                </div>
                <div className="text-right text-[11px] text-muted">
                  <div>{e.board_id ? (titles.get(e.board_id) ?? "deleted board") : "—"}</div>
                  <div>{new Date(e.created_at).toLocaleString()}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

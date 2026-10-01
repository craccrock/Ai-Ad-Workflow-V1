"use client";

import { format, parseISO } from "date-fns";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card } from "@/components/ui/misc";
import { formatUsd } from "@/lib/utils";

export type SpendStats = {
  today: number;
  week: number;
  month: number;
  all_time: number;
  count_all: number;
  by_model: { model: string; name: string; spend: number; count: number }[];
  by_user: { user_id: string; name: string; spend: number; count: number }[];
  daily: { day: string; spend: number; count: number }[];
};

const GOLD = "#c4a87c";
const money = (n: number) => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function StatTile({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <Card className="p-5">
      <div className="text-[11px] uppercase tracking-[0.12em] text-cream-2">{label}</div>
      <div className="mt-2 font-mono text-3xl text-cream">{money(value)}</div>
      {sub ? <div className="mt-1 text-xs text-muted">{sub}</div> : null}
    </Card>
  );
}

/** Ranked horizontal bars — one hue (magnitude), values in text ink, not series color. */
function RankedBars({ title, rows }: { title: string; rows: { key: string; name: string; spend: number; count: number }[] }) {
  const max = Math.max(...rows.map((r) => Number(r.spend)), 0.0001);
  return (
    <Card className="p-5">
      <h3 className="mb-4 font-serif text-lg text-cream">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">No spend yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="sr-only">
            <tr>
              <th>Name</th>
              <th>Spend</th>
              <th>Generations</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="group" title={`${r.name}: ${money(r.spend)} across ${r.count} generations`}>
                <td className="w-[38%] max-w-0 truncate py-1.5 pr-3 text-cream-2">{r.name}</td>
                <td className="py-1.5 pr-3">
                  <div className="h-2.5 w-full">
                    <div className="h-full rounded-r-[4px] bg-gold/85 transition-colors group-hover:bg-gold" style={{ width: `${Math.max(1.5, (Number(r.spend) / max) * 100)}%` }} />
                  </div>
                </td>
                <td className="whitespace-nowrap py-1.5 text-right font-mono text-xs text-cream">{money(r.spend)}</td>
                <td className="whitespace-nowrap py-1.5 pl-3 text-right font-mono text-[11px] text-muted">{r.count}×</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function SpendDashboard({ stats }: { stats: SpendStats }) {
  const daily = stats.daily.map((d) => ({ ...d, spend: Number(d.spend), label: format(parseISO(d.day), "MMM d") }));
  const last30 = daily.reduce((a, d) => a + d.spend, 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Today" value={stats.today} />
        <StatTile label="This week" value={stats.week} />
        <StatTile label="This month" value={stats.month} />
        <StatTile label="All time" value={stats.all_time} sub={`${stats.count_all.toLocaleString()} generations`} />
      </div>

      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-serif text-lg text-cream">Daily spend — last 30 days</h3>
          <span className="font-mono text-xs text-muted">{money(last30)} total</span>
        </div>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={daily} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: "#7a7568", fontSize: 11 }} interval="preserveStartEnd" minTickGap={24} />
              <YAxis tickLine={false} axisLine={false} width={48} tick={{ fill: "#7a7568", fontSize: 11 }} tickFormatter={(v: number) => `$${v < 10 ? v.toFixed(1) : Math.round(v)}`} />
              <Tooltip
                cursor={{ stroke: "rgba(245,240,232,0.25)", strokeWidth: 1 }}
                contentStyle={{ background: "#2e3d62", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, color: "#f5f0e8", fontSize: 12 }}
                labelStyle={{ color: "#b8b0a0" }}
                formatter={(value, _name, item) => [`${formatUsd(Number(value))} · ${(item.payload as { count: number }).count} gens`, "Spend"]}
              />
              <Line type="monotone" dataKey="spend" stroke={GOLD} strokeWidth={2} dot={false} activeDot={{ r: 4, fill: GOLD, stroke: "#263354", strokeWidth: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <RankedBars title="Spend by model" rows={stats.by_model.map((r) => ({ key: r.model, name: r.name, spend: Number(r.spend), count: r.count }))} />
        <RankedBars title="Spend by user" rows={stats.by_user.map((r) => ({ key: r.user_id, name: r.name ?? "Unknown", spend: Number(r.spend), count: r.count }))} />
      </div>
    </div>
  );
}

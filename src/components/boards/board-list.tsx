"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/misc";
import { api } from "@/lib/client-api";
import type { Profile } from "@/lib/types";

export type BoardSummary = {
  id: string;
  title: string;
  user_id: string;
  model: string;
  aspect_ratio: string;
  created_at: string;
  updated_at: string;
  user: { id: string; display_name: string } | null;
  beats: { count: number }[];
};

export function BoardList({ boards: initial, profile }: { boards: BoardSummary[]; profile: Profile }) {
  const router = useRouter();
  const [boards, setBoards] = useState(initial);
  const [creating, setCreating] = useState(false);

  async function create() {
    setCreating(true);
    try {
      const b = await api<{ id: string }>("/api/boards", { method: "POST", json: {} });
      router.push(`/boards/${b.id}`);
    } catch (e) {
      toast.error("Couldn't create board", { description: e instanceof Error ? e.message : String(e) });
      setCreating(false);
    }
  }

  async function remove(b: BoardSummary) {
    if (!window.confirm(`Delete "${b.title}"? Generated images stay in the gallery.`)) return;
    try {
      await api(`/api/boards/${b.id}`, { method: "DELETE" });
      setBoards((prev) => prev.filter((x) => x.id !== b.id));
    } catch (e) {
      toast.error("Delete failed", { description: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <>
      <PageHeader title="B-roll Boards" subtitle="Paste a script, split it into beats, and one-shot every B-roll starter image.">
        <Button variant="gold" onClick={create} disabled={creating}>
          <Plus /> {creating ? "Creating…" : "New board"}
        </Button>
      </PageHeader>
      {boards.length === 0 ? (
        <div className="rounded-[8px] border border-dashed border-hairline px-6 py-20 text-center">
          <p className="font-serif text-xl text-cream">No boards yet</p>
          <p className="mt-2 text-sm text-cream-2">Create one and paste your first script.</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {boards.map((b) => (
            <div key={b.id} className="group relative rounded-[8px] border border-hairline bg-surface p-4 transition-colors hover:border-white/20">
              <Link href={`/boards/${b.id}`} className="block">
                <h3 className="font-serif text-lg text-cream">{b.title}</h3>
                <p className="mt-1 text-xs text-cream-2">
                  {b.beats?.[0]?.count ?? 0} beats · {b.user?.display_name ?? "?"} · updated {formatDistanceToNowStrict(new Date(b.updated_at), { addSuffix: true })}
                </p>
              </Link>
              {profile.role === "admin" || b.user_id === profile.id ? (
                <button type="button" onClick={() => void remove(b)} aria-label="Delete board" className="absolute right-3 top-3 rounded p-1 text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100">
                  <Trash2 className="size-4" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

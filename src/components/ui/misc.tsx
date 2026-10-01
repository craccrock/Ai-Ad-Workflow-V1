import * as React from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("rounded-[8px] border border-hairline bg-surface", className)} {...props} />;
}

export function Badge({ className, tone = "default", ...props }: React.ComponentProps<"span"> & { tone?: "default" | "gold" | "success" | "danger" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em]",
        tone === "default" && "border-hairline text-cream-2",
        tone === "gold" && "border-gold/40 text-gold",
        tone === "success" && "border-success/40 text-success",
        tone === "danger" && "border-danger/40 text-danger",
        className,
      )}
      {...props}
    />
  );
}

export function UserAvatar({ name, url, size = 20, bot }: { name: string; url?: string | null; size?: number; bot?: boolean }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" width={size} height={size} className="rounded-full object-cover" style={{ width: size, height: size }} />
  ) : (
    <span
      aria-hidden
      className={cn(
        "inline-flex items-center justify-center rounded-full font-mono",
        bot ? "bg-gold/20 text-gold" : "bg-elevated text-cream-2",
      )}
      style={{ width: size, height: size, fontSize: Math.max(8, size * 0.42) }}
    >
      {initials}
    </span>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-serif text-3xl text-cream sm:text-4xl">{title}</h1>
        {subtitle ? <p className="mt-2 text-sm text-cream-2">{subtitle}</p> : null}
      </div>
      {children}
    </div>
  );
}

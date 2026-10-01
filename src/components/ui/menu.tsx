"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Small click-to-open menu: closes on outside click, Escape, or after a choice. */
export function Menu({
  trigger,
  children,
  align = "left",
  className,
}: {
  trigger: (props: { open: boolean; onClick: () => void }) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={cn("relative", className)}>
      {trigger({ open, onClick: () => setOpen((v) => !v) })}
      {open ? (
        <div
          role="menu"
          className={cn(
            "absolute bottom-full z-30 mb-1 min-w-[190px] overflow-hidden rounded-[6px] border border-hairline bg-elevated py-1 shadow-lg",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({ onClick, children, hint }: { onClick: () => void; children: React.ReactNode; hint?: string }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="block w-full px-3 py-1.5 text-left text-xs text-cream-2 transition-colors hover:bg-white/5 hover:text-cream"
    >
      {children}
      {hint ? <span className="mt-0.5 block text-[10px] text-muted">{hint}</span> : null}
    </button>
  );
}

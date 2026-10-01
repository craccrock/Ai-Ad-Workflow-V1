"use client";

import { KeyRound } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserAvatar } from "@/components/ui/misc";
import type { Profile } from "@/lib/types";
import { cn } from "@/lib/utils";

export function Nav({ profile }: { profile: Profile }) {
  const pathname = usePathname();
  const links = [
    { href: "/", label: "Studio" },
    { href: "/library", label: "Library" },
    ...(profile.role === "admin"
      ? [
          { href: "/admin", label: "Spend" },
          { href: "/admin/team", label: "Team & API" },
        ]
      : []),
  ];
  const isActive = (href: string) => (href === "/" ? pathname === "/" : href === "/admin" ? pathname === "/admin" : pathname.startsWith(href));

  return (
    <header className="sticky top-0 z-30 border-b border-hairline bg-navy/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-6 px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex shrink-0 items-center gap-3">
          <Image src="/madaket-dog-sketch.png" alt="Madaket" width={24} height={36} priority className="opacity-90" />
          <span className="hidden font-serif text-lg text-cream sm:inline">Madaket Gen Studio</span>
        </Link>

        <nav className="-mb-px flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                "relative whitespace-nowrap px-3 py-5 text-sm transition-colors",
                isActive(l.href) ? "text-cream" : "text-cream-2 hover:text-cream",
              )}
            >
              {l.label}
              {isActive(l.href) ? <span className="absolute inset-x-3 bottom-0 h-px bg-gold" /> : null}
            </Link>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden items-center gap-2 text-sm text-cream-2 md:flex">
            <UserAvatar name={profile.display_name} url={profile.avatar_url} size={24} />
            {profile.display_name}
          </span>
          <Link href="/set-password" title="Change password" aria-label="Change password" className="rounded p-1 text-cream-2 hover:bg-white/5 hover:text-cream">
            <KeyRound className="size-4" />
          </Link>
          <form action="/auth/signout" method="post">
            <button className="border-b border-cream/30 pb-0.5 text-xs text-cream-2 hover:border-cream hover:text-cream">Sign out</button>
          </form>
        </div>
      </div>
    </header>
  );
}

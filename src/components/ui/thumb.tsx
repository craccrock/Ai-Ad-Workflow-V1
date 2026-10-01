"use client";

import Image from "next/image";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Grid thumbnails. Our outputs are 5–7 MB originals, and a card only needs a few hundred pixels,
 * so images go through Next's optimizer (resized once, then cached at the edge) instead of being
 * downloaded whole from Supabase Storage — that was burning the storage egress quota.
 * Videos show their first frame and only stream while hovered.
 */

const STORAGE_HOST = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname;
  } catch {
    return "";
  }
})();

/** The optimizer only accepts hosts allow-listed in next.config.ts. */
function optimizable(url: string) {
  try {
    return new URL(url).hostname === STORAGE_HOST;
  } catch {
    return false;
  }
}

export function ImageThumb({ src, alt, sizes, className }: { src: string; alt: string; sizes: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !optimizable(src)) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} loading="lazy" className={className} />;
  }
  return <Image src={src} alt={alt} fill sizes={sizes} className={className} onError={() => setFailed(true)} />;
}

/** First frame only; plays muted on hover, so a grid of clips doesn't stream megabytes on sight. */
export function VideoThumb({ src, className }: { src: string; className?: string }) {
  return (
    <video
      // #t=0.1 makes the browser paint the first frame without downloading the whole clip.
      src={`${src}#t=0.1`}
      muted
      loop
      playsInline
      preload="metadata"
      className={cn(className)}
      onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
      onMouseLeave={(e) => {
        e.currentTarget.pause();
        e.currentTarget.currentTime = 0.1;
      }}
    />
  );
}

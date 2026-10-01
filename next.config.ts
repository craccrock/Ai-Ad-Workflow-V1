import type { NextConfig } from "next";

/** Supabase Storage is the only remote image source; fall back to any Supabase host at build time. */
const storageHost = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname;
  } catch {
    return "*.supabase.co";
  }
})();

const nextConfig: NextConfig = {
  images: {
    // Gallery and library thumbnails are resized here instead of shipping 5–7 MB originals to every card.
    remotePatterns: [{ protocol: "https", hostname: storageHost, pathname: "/storage/v1/object/public/**" }],
    // Output files never change once written, so the optimized copies can be kept for a long time.
    minimumCacheTTL: 2678400, // 31 days
  },
};

export default nextConfig;

import { Nav } from "@/components/nav";
import { requireSessionProfile } from "@/lib/auth";

export default async function StudioLayout({ children }: LayoutProps<"/">) {
  const profile = await requireSessionProfile();
  return (
    <div className="min-h-screen">
      <Nav profile={profile} />
      <main className="mx-auto w-full max-w-[1400px] px-4 pb-24 pt-6 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}

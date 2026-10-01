import { Library } from "@/components/library/library";
import { requireSessionProfile } from "@/lib/auth";

export default async function LibraryPage() {
  const profile = await requireSessionProfile();
  return <Library profile={profile} />;
}

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getProfileDirectory } from "@/lib/profile-directory.functions";
import type { ProfileDirectory } from "@/lib/person-resolver";
import { useSession } from "./useSession";

/** Fetches the profile email → full_name map once per session. */
export function useProfileDirectory(): {
  directory: ProfileDirectory;
  isLoading: boolean;
  isError: boolean;
} {
  const { userId } = useSession();
  const fn = useServerFn(getProfileDirectory);
  const q = useQuery({
    queryKey: ["profile-directory"],
    enabled: !!userId,
    queryFn: () => fn(),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const directory = useMemo<ProfileDirectory>(() => {
    const m = new Map<string, string>();
    for (const e of q.data?.entries ?? []) m.set(e.email, e.full_name);
    return m;
  }, [q.data]);
  return { directory, isLoading: q.isLoading, isError: q.isError };
}

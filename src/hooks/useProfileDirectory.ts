import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getProfileDirectory } from "@/lib/profile-directory.functions";
import type { ProfileDirectory } from "@/lib/person-resolver";
import { useSession } from "./useSession";
import { isRecoverableDataReadError } from "@/lib/transient-errors";

/** Fetches the profile email → full_name map once per session. */
export function useProfileDirectory(): {
  directory: ProfileDirectory;
  isLoading: boolean;
  isError: boolean;
} {
  const { userId, loading } = useSession();
  const fn = useServerFn(getProfileDirectory);
  const q = useQuery({
    queryKey: ["profile-directory"],
    enabled: !!userId && !loading,
    queryFn: async () => {
      try {
        return await fn();
      } catch (error) {
        if (isRecoverableDataReadError(error)) {
          console.warn("[profiles] Directory lookup unavailable; continuing without name mapping.", error);
          return { entries: [] };
        }
        throw error;
      }
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => !isRecoverableDataReadError(error) && failureCount < 2,
  });
  const directory = useMemo<ProfileDirectory>(() => {
    const m = new Map<string, string>();
    for (const e of q.data?.entries ?? []) m.set(e.email, e.full_name);
    return m;
  }, [q.data]);
  return { directory, isLoading: q.isLoading, isError: q.isError };
}

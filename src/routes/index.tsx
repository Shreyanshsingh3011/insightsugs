/**
 * Route: "/" (index)
 * Access: public entry point — performs no rendering, only redirects.
 * Purpose: on load, checks for a usable Supabase session and redirects to either the last
 * pre-login path (stored in sessionStorage under "postLoginPath" by _authenticated.tsx) or
 * "/login" if unauthenticated.
 * Data dependencies: Supabase auth session via getUsableSupabaseSession (validates token, not just presence).
 * Gotchas: during SSR (no `window`) it always redirects to "/login" since session state isn't
 * available server-side here; the real check happens client-side on hydration.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { getUsableSupabaseSession } from "@/lib/auth-session";

/** Reads and clears the saved post-login redirect target from sessionStorage, falling back to "/agent" if absent/invalid/pointing at /login. */
function consumePostLoginPath() {
  if (typeof window === "undefined") return "/agent";
  const savedPath = window.sessionStorage.getItem("postLoginPath");
  window.sessionStorage.removeItem("postLoginPath");
  if (!savedPath || !savedPath.startsWith("/") || savedPath.startsWith("//") || savedPath.startsWith("/login")) {
    return "/agent";
  }
  return savedPath;
}

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    if (typeof window === "undefined") {
      throw redirect({ to: "/login" });
    }
    const session = await getUsableSupabaseSession(2500, { validate: true });
    throw redirect({ to: session ? consumePostLoginPath() : "/login" });
  },
});

import { createMiddleware } from "@tanstack/react-start";
import { getUsableSupabaseSession, readStoredSession } from "@/lib/auth-session";

export const attachUsableSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    // Server functions validate the bearer token. Client-side attachment should
    // not depend on a live auth-network round trip, because transient auth/API
    // timeouts were causing protected RPCs to be sent with no Authorization.
    const session = (await getUsableSupabaseSession(1500, { validate: false })) ?? readStoredSession();
    const token = session?.access_token;
    return next({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  },
);
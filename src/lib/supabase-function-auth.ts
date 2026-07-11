import { createMiddleware } from "@tanstack/react-start";
import { getUsableSupabaseSession } from "@/lib/auth-session";

export const attachUsableSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    const session = await getUsableSupabaseSession(1500);
    const token = session?.access_token;
    return next({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  },
);
import { createMiddleware } from "@tanstack/react-start";
import { getUsableSupabaseSession } from "@/lib/auth-session";

export const attachUsableSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    const session = await getUsableSupabaseSession(4000, {
      validate: true,
      strictValidation: false,
      clearOnInvalid: false,
    });
    const token = session?.access_token;
    return next({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  },
);
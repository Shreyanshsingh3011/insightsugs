import { createFileRoute, redirect } from "@tanstack/react-router";
import { getUsableSupabaseSession } from "@/lib/auth-session";

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

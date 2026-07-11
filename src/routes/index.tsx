import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    if (typeof window === "undefined") {
      throw redirect({ to: "/login" });
    }
    const { data } = await supabase.auth.getSession();
    const savedPath = window.sessionStorage.getItem("postLoginPath");
    window.sessionStorage.removeItem("postLoginPath");
    const nextPath = savedPath === "/agent" ? "/agent" : "/insights";
    throw redirect({ to: data.session ? nextPath : "/login" });
  },
});

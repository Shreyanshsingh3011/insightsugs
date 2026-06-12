import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { callEmergent, EmergentNotConfiguredError } from "./emergent-client";
import type { DependencyChainResponse } from "./dependency-chain";

// Server-side dependency inference. Emergent fetches the Apps Script link
// itself and returns the resolved chain.
export const inferDependenciesEmergent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { appsScriptUrl: string; logic?: string }) =>
    z
      .object({
        appsScriptUrl: z.string().trim().min(1).max(2000),
        logic: z.string().max(20_000).optional().default(""),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    try {
      const out = await callEmergent<DependencyChainResponse>("dependencies", {
        appsScriptUrl: data.appsScriptUrl,
        logic: data.logic ?? "",
      });
      return { ok: true as const, chain: out };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false as const,
        code:
          e instanceof EmergentNotConfiguredError
            ? "EMERGENT_NOT_CONFIGURED"
            : "EMERGENT_UNAVAILABLE",
        message:
          e instanceof EmergentNotConfiguredError
            ? "AI service isn't connected yet. Ask a super admin to set it up in Admin → Integrations."
            : `Dependency AI is unavailable right now (${msg.slice(0, 200)}). You can still add dependencies manually.`,
      };
    }
  });

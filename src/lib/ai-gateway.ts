// Minimal, fallback-free Lovable AI Gateway provider — used by call sites
// that don't need run-id tracking. Prefer ai-gateway.server.ts for new code;
// this is kept for existing simpler callers.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createFallbackFetch } from "./ai-fallback.server";

export const createLovableAiGatewayProvider = (lovableApiKey: string) =>
  createOpenAICompatible({
    name: "lovable",
    baseURL: "https://ai.gateway.lovable.dev/v1",
    headers: {
      "Lovable-API-Key": lovableApiKey,
      "X-Lovable-AIG-SDK": "vercel-ai-sdk",
    },
    fetch: createFallbackFetch(),
  });

// Lovable AI Gateway provider for the AI SDK. Server-only.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createFallbackFetch } from "./ai-fallback.server";


export const LOVABLE_AIG_RUN_ID_HEADER = "X-Lovable-AIG-Run-ID";

/**
 * Wraps fetch to inject/capture the X-Lovable-AIG-Run-ID header. `waitForRunId`
 * resolves once the header is seen on a response (or immediately if an
 * initialRunId was supplied), letting callers correlate a stream with its run.
 */
export function createLovableAiGatewayRunIdFetch(initialRunId?: string) {
  let runId = initialRunId?.trim() || undefined;
  let resolveRunId: (value: string | undefined) => void = () => {};
  let runIdResolved = false;
  const runIdReady = new Promise<string | undefined>((resolve) => {
    resolveRunId = resolve;
  });
  const publishRunId = (value?: string) => {
    const next = value?.trim() || undefined;
    if (!runId && next) runId = next;
    if (!runIdResolved) { runIdResolved = true; resolveRunId(runId); }
  };
  if (runId) publishRunId(runId);
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (runId && !headers.has(LOVABLE_AIG_RUN_ID_HEADER)) headers.set(LOVABLE_AIG_RUN_ID_HEADER, runId);
      const wrapped = createFallbackFetch();
      try {
        const response = await wrapped(input, { ...init, headers });
        publishRunId(response.headers.get(LOVABLE_AIG_RUN_ID_HEADER) ?? undefined);
        return response;
      } catch (error) {
        publishRunId(undefined);
        throw error;
      }
    }) as typeof fetch,

    getRunId: () => runId,
    waitForRunId: () => (runId ? Promise.resolve(runId) : runIdReady),
  };
}

/** Build an AI-SDK-compatible provider pointed at the Lovable Gateway, wired through the fallback + run-id-tracking fetch. */
export function createLovableAiGatewayProvider(
  lovableApiKey: string,
  initialRunId?: string,
  options?: { structuredOutputs?: boolean },
) {
  const runIdFetch = createLovableAiGatewayRunIdFetch(initialRunId);
  const provider = createOpenAICompatible({
    name: "lovable",
    baseURL: "https://ai.gateway.lovable.dev/v1",
    supportsStructuredOutputs: options?.structuredOutputs ?? false,
    headers: {
      "Lovable-API-Key": lovableApiKey,
      "X-Lovable-AIG-SDK": "vercel-ai-sdk",
    },
    fetch: runIdFetch.fetch,
  });
  return Object.assign(provider, {
    getRunId: runIdFetch.getRunId,
    waitForRunId: runIdFetch.waitForRunId,
  });
}

/** Read the AIG run id off an inbound Request's headers (e.g. inside an API route handling a gateway webhook). */
export function getLovableAiGatewayRunId(request: Request) {
  return request.headers.get(LOVABLE_AIG_RUN_ID_HEADER)?.trim() || undefined;
}

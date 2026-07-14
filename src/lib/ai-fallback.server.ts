// Server-only: routes chat completion requests through Lovable Gateway →
// Gemini → OpenRouter (free models) → Groq with a per-provider circuit
// breaker so a persistently failing tier is skipped for 60s.

const LOVABLE_BASE = "https://ai.gateway.lovable.dev/v1";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const GROQ_BASE = "https://api.groq.com/openai/v1";

// Free OpenRouter models, in preferred order. Tried in order until one accepts.
const OPENROUTER_FREE_MODELS = [
  "deepseek/deepseek-r1:free",
  "openai/gpt-oss-20b:free",
  "z-ai/glm-4.5-air:free",
  "meta-llama/llama-3.2-3b-instruct:free",
  "google/gemma-2-9b-it:free",
];

type Provider = "gateway" | "gemini" | "openrouter" | "groq";
type BreakerState = { openedAt: number; status: number; error?: string };
const BREAKER_MS = 60_000;
const breakers: Partial<Record<Provider, BreakerState>> = {};

function isOpen(p: Provider): BreakerState | null {
  const b = breakers[p];
  if (!b) return null;
  if (Date.now() - b.openedAt > BREAKER_MS) {
    delete breakers[p];
    return null;
  }
  return b;
}
function trip(p: Provider, status: number, error?: string) {
  breakers[p] = { openedAt: Date.now(), status, error };
  // Loud so downgrades are visible in server-function-logs, not silent failures.
  console.warn(`[ai-fallback] breaker OPEN provider=${p} status=${status}${error ? ` error=${error}` : ""}`);
}
function reset(p: Provider) {
  if (breakers[p]) console.warn(`[ai-fallback] breaker CLOSED provider=${p}`);
  delete breakers[p];
}
function served(p: Provider) {
  if (p !== "gateway") console.warn(`[ai-fallback] request served by ${p} (primary gateway unavailable)`);
}

export function getBreakerSnapshot() {
  const now = Date.now();
  const out: Record<string, { open: boolean; ms_remaining: number; status?: number; error?: string }> = {};
  for (const p of ["gateway", "gemini", "openrouter", "groq"] as Provider[]) {
    const b = breakers[p];
    out[p] = b
      ? { open: true, ms_remaining: Math.max(0, BREAKER_MS - (now - b.openedAt)), status: b.status, error: b.error }
      : { open: false, ms_remaining: 0 };
  }
  return out;
}

function isChatCompletions(url: string) {
  return url.includes("/chat/completions");
}

function mapGeminiModel(model: unknown): string | undefined {
  if (typeof model !== "string") return undefined;
  const normalized = model.startsWith("google/") ? model.slice("google/".length) : model;
  if (
    normalized === "gemini-3-flash-preview" ||
    normalized === "gemini-3.1-flash-lite" ||
    normalized === "gemini-3.5-flash" ||
    normalized === "gemini-3.1-pro-preview"
  ) {
    return "gemini-2.5-flash";
  }
  if (normalized === "gemini-2.5-pro") return "gemini-2.5-pro";
  if (normalized === "gemini-2.5-flash" || normalized === "gemini-2.5-flash-lite") return normalized;
  if (model.startsWith("openai/") || !model.includes("/")) return "gemini-2.5-flash";
  return model;
}

function stripHeaders(init?: RequestInit) {
  const h = new Headers(init?.headers);
  h.delete("Lovable-API-Key");
  h.delete("lovable-api-key");
  h.delete("X-Lovable-AIG-SDK");
  h.set("Content-Type", "application/json");
  return h;
}

async function callGemini(url: string, init: RequestInit | undefined, key: string): Promise<Response> {
  const geminiUrl = url.replace(LOVABLE_BASE, GEMINI_BASE);
  let body = init?.body;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      const mapped = mapGeminiModel(parsed.model);
      if (mapped) parsed.model = mapped;
      delete parsed.service_tier;
      body = JSON.stringify(parsed);
    } catch { /* leave body */ }
  }
  const headers = stripHeaders(init);
  headers.set("Authorization", `Bearer ${key}`);
  return fetch(geminiUrl, { ...init, headers, body });
}

async function callOpenRouter(
  url: string,
  init: RequestInit | undefined,
  key: string,
  modelOverride: string,
): Promise<Response> {
  const orUrl = url.replace(LOVABLE_BASE, OPENROUTER_BASE);
  let body = init?.body;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      parsed.model = modelOverride;
      delete parsed.service_tier;
      body = JSON.stringify(parsed);
    } catch { /* leave body */ }
  }
  const headers = stripHeaders(init);
  headers.set("Authorization", `Bearer ${key}`);
  headers.set("HTTP-Referer", "https://insightsugs.lovable.app");
  headers.set("X-Title", "DelayLens");
  return fetch(orUrl, { ...init, headers, body });
}

async function callGroq(url: string, init: RequestInit | undefined, key: string): Promise<Response> {
  const groqUrl = url.replace(LOVABLE_BASE, GROQ_BASE);
  let body = init?.body;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      parsed.model = "llama-3.3-70b-versatile";
      delete parsed.service_tier;
      body = JSON.stringify(parsed);
    } catch { /* leave body */ }
  }
  const headers = stripHeaders(init);
  headers.set("Authorization", `Bearer ${key}`);
  return fetch(groqUrl, { ...init, headers, body });
}

function shouldRetry(status: number) {
  return status === 402 || status === 429 || status >= 500;
}

/**
 * Circuit-breaker-aware fetch that transparently retries chat completions
 * against Gemini → OpenRouter (free) → Groq when the primary tier fails.
 */
export function createFallbackFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const chat = isChatCompletions(url);
    const geminiKey = process.env.GEMINI_API_KEY;
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    const groqKey = process.env.GROQ_API_KEY;
    const hasFallback = !!(geminiKey || openRouterKey || groqKey);

    // Skip gateway if breaker is open and a fallback is available
    if (chat && isOpen("gateway") && hasFallback) {
      // fall through to fallbacks directly
    } else {
      const response = await baseFetch(input, init);
      if (response.ok) {
        if (chat) { reset("gateway"); served("gateway"); }
        return response;
      }
      if (!chat || !shouldRetry(response.status)) return response;
      trip("gateway", response.status);
    }

    // Tier 2: Gemini
    if (chat && geminiKey && !isOpen("gemini")) {
      try {
        const retry = await callGemini(url, init, geminiKey);
        if (retry.ok) { reset("gemini"); served("gemini"); return retry; }
        if (shouldRetry(retry.status)) trip("gemini", retry.status);
        else if (!openRouterKey && !groqKey) return retry;
      } catch (e) {
        trip("gemini", 0, (e as Error).message);
      }
    }

    // Tier 3: OpenRouter free models (walk the list until one accepts)
    if (chat && openRouterKey && !isOpen("openrouter")) {
      let lastResponse: Response | null = null;
      for (const model of OPENROUTER_FREE_MODELS) {
        try {
          const retry = await callOpenRouter(url, init, openRouterKey, model);
          if (retry.ok) { reset("openrouter"); served("openrouter"); return retry; }
          // Peek at body to detect "unavailable for free" errors and skip to next model
          const bodyText = await retry.clone().text().catch(() => "");
          const unavailableForFree = /unavailable for free|paid version is available/i.test(bodyText);
          lastResponse = new Response(bodyText, { status: retry.status, headers: retry.headers });
          if (retry.status === 401 || retry.status === 403) {
            trip("openrouter", retry.status);
            break; // key-level failure, all models will fail
          }
          if (unavailableForFree) continue;
          if (retry.status >= 500) continue;
          if (retry.status === 429) continue;
          if (retry.status === 404 || retry.status === 400 || retry.status === 402) continue;
          break;
        } catch (e) {
          trip("openrouter", 0, (e as Error).message);
          break;
        }
      }
      if (lastResponse && !groqKey) return lastResponse;
      if (lastResponse && shouldRetry(lastResponse.status)) {
        // fall through to groq
      } else if (lastResponse) {
        return lastResponse;
      }
    }

    // Tier 4: Groq
    if (chat && groqKey && !isOpen("groq")) {
      try {
        const retry = await callGroq(url, init, groqKey);
        if (retry.ok) { reset("groq"); served("groq"); return retry; }
        if (shouldRetry(retry.status)) trip("groq", retry.status);
        return retry;
      } catch (e) {
        trip("groq", 0, (e as Error).message);
      }
    }

    // All tiers exhausted — return the last upstream failure we captured
    // instead of re-issuing the original request (which would double-bill
    // and re-trigger the tripped breaker).
    if (lastResponse) return lastResponse;
    return new Response(
      JSON.stringify({ error: { message: "All AI providers unavailable", code: "ai_all_providers_down" } }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

export async function lovableAiFetchWithFallback(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return createFallbackFetch()(input, init);
}

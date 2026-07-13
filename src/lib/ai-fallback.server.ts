// Server-only: routes chat completion requests to Lovable Gateway, Gemini,
// then Groq with a per-provider circuit breaker so a persistently failing
// tier is skipped for 60s instead of being retried on every request.

const LOVABLE_BASE = "https://ai.gateway.lovable.dev/v1";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const GROQ_BASE = "https://api.groq.com/openai/v1";

type Provider = "gateway" | "gemini" | "groq";
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
}
function reset(p: Provider) {
  delete breakers[p];
}

export function getBreakerSnapshot() {
  const now = Date.now();
  const out: Record<string, { open: boolean; ms_remaining: number; status?: number; error?: string }> = {};
  for (const p of ["gateway", "gemini", "groq"] as Provider[]) {
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
 * against Gemini then Groq when the primary tier fails or is tripped.
 */
export function createFallbackFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const chat = isChatCompletions(url);
    const geminiKey = process.env.GEMINI_API_KEY;
    const groqKey = process.env.GROQ_API_KEY;

    // Skip gateway if breaker is open
    if (chat && isOpen("gateway") && (geminiKey || groqKey)) {
      // fall through to fallbacks directly
    } else {
      const response = await baseFetch(input, init);
      if (response.ok) {
        if (chat) reset("gateway");
        return response;
      }
      if (!chat || !shouldRetry(response.status)) return response;
      trip("gateway", response.status);
    }

    // Tier 2: Gemini
    if (chat && geminiKey && !isOpen("gemini")) {
      try {
        const retry = await callGemini(url, init, geminiKey);
        if (retry.ok) { reset("gemini"); return retry; }
        if (shouldRetry(retry.status)) trip("gemini", retry.status);
        else if (!groqKey) return retry;
      } catch (e) {
        trip("gemini", 0, (e as Error).message);
      }
    }

    // Tier 3: Groq
    if (chat && groqKey && !isOpen("groq")) {
      try {
        const retry = await callGroq(url, init, groqKey);
        if (retry.ok) { reset("groq"); return retry; }
        if (shouldRetry(retry.status)) trip("groq", retry.status);
        return retry;
      } catch (e) {
        trip("groq", 0, (e as Error).message);
      }
    }

    // All tiers exhausted — surface the last gateway response
    return baseFetch(input, init);
  }) as typeof fetch;
}

export async function lovableAiFetchWithFallback(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return createFallbackFetch()(input, init);
}

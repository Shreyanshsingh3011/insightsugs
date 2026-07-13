// Server-only: wraps a fetch to the Lovable AI Gateway so that when the
// gateway returns 402 (credits exhausted), 429 (rate limited), or 5xx, the
// same OpenAI-compatible chat request is retried against Google's Gemini
// OpenAI-compatible endpoint using GEMINI_API_KEY. Non-chat routes
// (embeddings, images) pass through unchanged.

const LOVABLE_BASE = "https://ai.gateway.lovable.dev/v1";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const GROQ_BASE = "https://api.groq.com/openai/v1";


function isChatCompletions(url: string) {
  return url.includes("/chat/completions");
}

function mapModel(model: unknown): string | undefined {
  if (typeof model !== "string") return undefined;
  // Lovable Gateway model ids do not always map 1:1 to Google AI Studio ids.
  // Keep the user-facing feature working by routing preview/new gateway models
  // to the stable Gemini API model available behind GEMINI_API_KEY.
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
  // For OpenAI or unknown model ids, fall back to a sensible Gemini default.
  if (model.startsWith("openai/") || !model.includes("/")) return "gemini-2.5-flash";
  return model;
}

async function callGemini(url: string, init: RequestInit | undefined, geminiKey: string): Promise<Response> {
  const geminiUrl = url.replace(LOVABLE_BASE, GEMINI_BASE);
  let body = init?.body;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      const mapped = mapModel(parsed.model);
      if (mapped) parsed.model = mapped;
      body = JSON.stringify(parsed);
    } catch {
      // leave body as-is
    }
  }
  const headers = new Headers(init?.headers);
  headers.delete("Lovable-API-Key");
  headers.delete("lovable-api-key");
  headers.delete("X-Lovable-AIG-SDK");
  headers.set("Authorization", `Bearer ${geminiKey}`);
  headers.set("Content-Type", "application/json");
  return fetch(geminiUrl, { ...init, headers, body });
}

async function callGroq(url: string, init: RequestInit | undefined, groqKey: string): Promise<Response> {
  const groqUrl = url.replace(LOVABLE_BASE, GROQ_BASE);
  let body = init?.body;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      // Groq's flagship fast model; OpenAI-compatible chat completions.
      parsed.model = "llama-3.3-70b-versatile";
      // Groq rejects some OpenAI-only fields; strip the ones we know about.
      delete parsed.service_tier;
      body = JSON.stringify(parsed);
    } catch {
      // leave body as-is
    }
  }
  const headers = new Headers(init?.headers);
  headers.delete("Lovable-API-Key");
  headers.delete("lovable-api-key");
  headers.delete("X-Lovable-AIG-SDK");
  headers.set("Authorization", `Bearer ${groqKey}`);
  headers.set("Content-Type", "application/json");
  return fetch(groqUrl, { ...init, headers, body });
}

function shouldRetry(status: number) {
  return status === 402 || status === 429 || status >= 500;
}

export function createFallbackFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const response = await baseFetch(input, init);
    if (response.ok) return response;
    if (!isChatCompletions(url) || !shouldRetry(response.status)) return response;

    const geminiKey = process.env.GEMINI_API_KEY;
    const groqKey = process.env.GROQ_API_KEY;

    // Tier 2: Gemini direct
    if (geminiKey) {
      try {
        const retry = await callGemini(url, init, geminiKey);
        if (retry.ok) return retry;
        // Only fall through to Groq on retryable Gemini failures (e.g. 429).
        if (!shouldRetry(retry.status) && !groqKey) return retry;
      } catch {
        // fall through
      }
    }

    // Tier 3: Groq direct
    if (groqKey) {
      try {
        const retry = await callGroq(url, init, groqKey);
        if (retry.ok) return retry;
      } catch {
        // fall through
      }
    }

    return response;
  }) as typeof fetch;
}

// Direct helper used by non-SDK call sites (raw fetch to gateway).
export async function lovableAiFetchWithFallback(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return createFallbackFetch()(input, init);
}


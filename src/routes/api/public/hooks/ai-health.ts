// Diagnostic hook: pings chat + embeddings through the Gemini fallback path
// and reports which providers actually responded. Safe to call ad-hoc or
// from a monitor. Never returns keys.

import { createFileRoute } from "@tanstack/react-router";

function isAuthorized(request: Request): boolean {
  const url = new URL(request.url);
  const provided =
    request.headers.get("apikey") ??
    request.headers.get("x-api-key") ??
    (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "") ??
    url.searchParams.get("apikey") ??
    "";
  if (!provided) return false;
  const allowed = [
    process.env.SUPABASE_PUBLISHABLE_KEY,
    process.env.SUPABASE_ANON_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ].filter(Boolean) as string[];
  return allowed.includes(provided);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function pingGatewayChat(): Promise<{ ok: boolean; status: number; ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": process.env.LOVABLE_API_KEY ?? "",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5,
      }),
    });
    return { ok: res.ok, status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: (e as Error).message };
  }
}

async function pingGeminiChat(): Promise<{ ok: boolean; status: number; ms: number; error?: string }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { ok: false, status: 0, ms: 0, error: "GEMINI_API_KEY not set" };
  const t0 = Date.now();
  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "gemini-2.5-flash",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 5,
        }),
      },
    );
    return { ok: res.ok, status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: (e as Error).message };
  }
}

async function pingEmbeddings(): Promise<{ ok: boolean; provider: string; dims: number; ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    const { embedTexts } = await import("@/lib/embeddings.server");
    const vecs = await embedTexts(["health check"]);
    return {
      ok: Array.isArray(vecs) && vecs.length === 1 && vecs[0].length > 0,
      provider: "auto (gateway->gemini fallback)",
      dims: vecs?.[0]?.length ?? 0,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, provider: "auto", dims: 0, ms: Date.now() - t0, error: (e as Error).message };
  }
}

async function handle(request: Request): Promise<Response> {
  if (!isAuthorized(request)) return json({ error: "unauthorized" }, 401);
  const [gateway, gemini, embed] = await Promise.all([
    pingGatewayChat(),
    pingGeminiChat(),
    pingEmbeddings(),
  ]);
  const chatAvailable = gateway.ok || gemini.ok;
  return json({
    ok: chatAvailable && embed.ok,
    chat: {
      available: chatAvailable,
      active_provider: gateway.ok ? "lovable-gateway" : gemini.ok ? "gemini-direct" : "none",
      lovable_gateway: gateway,
      gemini_direct: gemini,
    },
    embeddings: embed,
    checked_at: new Date().toISOString(),
  });
}

export const Route = createFileRoute("/api/public/hooks/ai-health")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});

// Probes Gateway / Gemini / Groq chat + embeddings and records the result in
// public.integration_health so the AI status badge and /admin/health page
// have a live rolling view. Never returns keys.

import { createFileRoute } from "@tanstack/react-router";
import { getBreakerSnapshot } from "@/lib/ai-fallback.server";

type Ping = { ok: boolean; status: number; ms: number; error?: string };

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

async function pingChat(url: string, headers: Record<string, string>, model: string): Promise<Ping> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5,
      }),
    });
    // drain body so the connection can be reused
    try { await res.text(); } catch { /* ignore */ }
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

function statusFromPing(p: Ping): "ok" | "degraded" | "down" {
  if (p.ok) return "ok";
  if (p.status === 429 || p.status === 402) return "degraded";
  return "down";
}

async function recordHealth(rows: Array<{ name: string; status: string; latency_ms: number; error?: string | null; meta?: unknown }>) {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("integration_health").insert(
      rows.map((r) => ({
        name: r.name,
        status: r.status,
        latency_ms: r.latency_ms,
        error: r.error ?? null,
        meta: r.meta ?? null,
      })),
    );
  } catch {
    /* observability write failures must never break the probe */
  }
}

async function handle(request: Request): Promise<Response> {
  if (!isAuthorized(request)) return json({ error: "unauthorized" }, 401);

  const lovableKey = process.env.LOVABLE_API_KEY ?? "";
  const geminiKey = process.env.GEMINI_API_KEY ?? "";
  const groqKey = process.env.GROQ_API_KEY ?? "";

  const [gateway, gemini, groq, embed] = await Promise.all([
    lovableKey
      ? pingChat("https://ai.gateway.lovable.dev/v1/chat/completions", { "Lovable-API-Key": lovableKey }, "google/gemini-2.5-flash")
      : Promise.resolve({ ok: false, status: 0, ms: 0, error: "LOVABLE_API_KEY not set" } as Ping),
    geminiKey
      ? pingChat("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", { Authorization: `Bearer ${geminiKey}` }, "gemini-2.5-flash")
      : Promise.resolve({ ok: false, status: 0, ms: 0, error: "GEMINI_API_KEY not set" } as Ping),
    groqKey
      ? pingChat("https://api.groq.com/openai/v1/chat/completions", { Authorization: `Bearer ${groqKey}` }, "llama-3.3-70b-versatile")
      : Promise.resolve({ ok: false, status: 0, ms: 0, error: "GROQ_API_KEY not set" } as Ping),
    pingEmbeddings(),
  ]);

  await recordHealth([
    { name: "ai.gateway", status: statusFromPing(gateway), latency_ms: gateway.ms, error: gateway.error, meta: { http: gateway.status } },
    { name: "ai.gemini",  status: statusFromPing(gemini),  latency_ms: gemini.ms,  error: gemini.error,  meta: { http: gemini.status } },
    { name: "ai.groq",    status: statusFromPing(groq),    latency_ms: groq.ms,    error: groq.error,    meta: { http: groq.status } },
    { name: "ai.embeddings", status: embed.ok ? "ok" : "down", latency_ms: embed.ms, error: embed.error ?? null, meta: { dims: embed.dims, provider: embed.provider } },
  ]);

  const chatAvailable = gateway.ok || gemini.ok || groq.ok;
  return json({
    ok: chatAvailable && embed.ok,
    chat: {
      available: chatAvailable,
      active_provider: gateway.ok ? "lovable-gateway" : gemini.ok ? "gemini-direct" : groq.ok ? "groq-direct" : "none",
      lovable_gateway: gateway,
      gemini_direct: gemini,
      groq_direct: groq,
    },
    embeddings: embed,
    breakers: getBreakerSnapshot(),
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

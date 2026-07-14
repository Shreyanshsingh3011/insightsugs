// Nightly probe of every OpenRouter free model in the fallback rotation.
// Records per-model status in public.integration_health so /admin/health can
// flag dead free slugs before the Copilot fallback path hits them at runtime.

import { createFileRoute } from "@tanstack/react-router";

const OPENROUTER_FREE_MODELS = [
  "deepseek/deepseek-r1:free",
  "openai/gpt-oss-20b:free",
  "z-ai/glm-4.5-air:free",
  "meta-llama/llama-3.2-3b-instruct:free",
  "google/gemma-2-9b-it:free",
];

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

async function probeModel(key: string, model: string) {
  const t0 = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://insightsugs.lovable.app",
        "X-Title": "DelayLens",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5,
      }),
    });
    const text = await res.text().catch(() => "");
    const dead = /unavailable for free|paid version is available|no endpoints found/i.test(text);
    return {
      model,
      ok: res.ok,
      status: res.status,
      ms: Date.now() - t0,
      dead,
      error: res.ok ? undefined : text.slice(0, 200),
    };
  } catch (e) {
    return { model, ok: false, status: 0, ms: Date.now() - t0, dead: false, error: (e as Error).message };
  }
}

async function handle(request: Request): Promise<Response> {
  if (!isAuthorized(request)) return json({ error: "unauthorized" }, 401);
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return json({ error: "OPENROUTER_API_KEY not set" }, 500);

  const results = await Promise.all(OPENROUTER_FREE_MODELS.map((m) => probeModel(key, m)));
  const dead = results.filter((r) => r.dead || (!r.ok && r.status === 404));

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("integration_health").insert(
      results.map((r) => ({
        name: `openrouter.${r.model}`,
        status: r.ok ? "ok" : r.dead ? "down" : r.status === 429 ? "degraded" : "down",
        latency_ms: r.ms,
        error: r.error ?? null,
        meta: { http: r.status, dead: r.dead } as never,
      })),
    );
  } catch { /* observability write failures are non-fatal */ }

  return json({
    ok: true,
    checked: results.length,
    healthy: results.filter((r) => r.ok).length,
    dead_models: dead.map((r) => r.model),
    results,
    checked_at: new Date().toISOString(),
  });
}

export const Route = createFileRoute("/api/public/hooks/model-health")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});

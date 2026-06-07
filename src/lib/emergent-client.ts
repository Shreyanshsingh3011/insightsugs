// Server-only Emergent client. Reads base_url + api_key from the
// `integrations` table (key='emergent') via the admin Supabase client.
// Never import this from client code.

export class EmergentNotConfiguredError extends Error {
  code = "EMERGENT_NOT_CONFIGURED" as const;
  constructor(msg = "Emergent integration is not configured.") {
    super(msg);
    this.name = "EmergentNotConfiguredError";
  }
}

type Cached = { base_url: string; api_key: string; fetchedAt: number };
let cache: Cached | null = null;
const TTL_MS = 60_000;

async function loadConfig(): Promise<Cached> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("integrations" as any)
    .select("base_url, api_key")
    .eq("key", "emergent")
    .maybeSingle();
  if (error) throw new Error(`Failed to load Emergent config: ${error.message}`);
  const row = data as { base_url?: string; api_key?: string } | null;
  if (!row || !row.base_url || !row.api_key) {
    throw new EmergentNotConfiguredError();
  }
  cache = {
    base_url: row.base_url.replace(/\/+$/, ""),
    api_key: row.api_key,
    fetchedAt: Date.now(),
  };
  return cache;
}

export function invalidateEmergentCache() {
  cache = null;
}

export async function callEmergent<T = unknown>(path: string, payload: unknown): Promise<T> {
  const cfg = await loadConfig();
  const clean = path.replace(/^\/+/, "");
  const res = await fetch(`${cfg.base_url}/${clean}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.api_key}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Emergent ${clean} failed (${res.status}): ${text.slice(0, 400)}`);
  }
  return (await res.json()) as T;
}

export async function pingEmergent(): Promise<{ ok: boolean; status: number; message: string }> {
  let cfg: Cached;
  try {
    cfg = await loadConfig();
  } catch (e) {
    if (e instanceof EmergentNotConfiguredError) {
      return { ok: false, status: 0, message: "Not configured." };
    }
    return { ok: false, status: 0, message: (e as Error).message };
  }
  try {
    const res = await fetch(`${cfg.base_url}/health`, {
      headers: { Authorization: `Bearer ${cfg.api_key}` },
    });
    const text = await res.text().catch(() => "");
    return {
      ok: res.ok,
      status: res.status,
      message: res.ok ? "Connection OK" : text.slice(0, 300) || res.statusText,
    };
  } catch (e) {
    return { ok: false, status: 0, message: (e as Error).message };
  }
}

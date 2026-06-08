// Server-only Emergent client. Reads endpoints from the `integrations` table
// (key='emergent'), supporting multiple named environments. Never import this
// from client code.

export class EmergentNotConfiguredError extends Error {
  code = "EMERGENT_NOT_CONFIGURED" as const;
  constructor(msg = "Emergent integration is not configured.") {
    super(msg);
    this.name = "EmergentNotConfiguredError";
  }
}

type Env = { id: string; name: string; base_url: string; api_key: string };
type Cached = { envs: Env[]; active: string | null; fetchedAt: number };
let cache: Cached | null = null;
const TTL_MS = 60_000;

async function loadConfig(): Promise<Cached> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("integrations" as any)
    .select("base_url, api_key, environments, active_env")
    .eq("key", "emergent")
    .maybeSingle();
  if (error) throw new Error(`Failed to load Emergent config: ${error.message}`);
  const row = data as
    | {
        base_url?: string;
        api_key?: string;
        environments?: Env[] | null;
        active_env?: string | null;
      }
    | null;
  let envs: Env[] = Array.isArray(row?.environments) ? [...(row!.environments as Env[])] : [];
  if (envs.length === 0 && row?.base_url) {
    envs = [
      { id: "prod", name: "Production", base_url: row.base_url, api_key: row.api_key ?? "" },
    ];
  }
  envs = envs.map((e) => ({ ...e, base_url: (e.base_url || "").replace(/\/+$/, "") }));
  let active = row?.active_env ?? null;
  if (!active || !envs.some((e) => e.id === active)) active = envs[0]?.id ?? null;
  if (envs.length === 0) throw new EmergentNotConfiguredError();
  cache = { envs, active, fetchedAt: Date.now() };
  return cache;
}

function pickEnv(cfg: Cached, envId?: string): Env {
  const id = envId || cfg.active;
  const env = cfg.envs.find((e) => e.id === id) ?? cfg.envs[0];
  if (!env || !env.base_url || !env.api_key) throw new EmergentNotConfiguredError();
  return env;
}

export function invalidateEmergentCache() {
  cache = null;
}

export async function callEmergent<T = unknown>(
  path: string,
  payload: unknown,
  envId?: string,
): Promise<T> {
  const cfg = await loadConfig();
  const env = pickEnv(cfg, envId);
  const clean = path.replace(/^\/+/, "");
  const res = await fetch(`${env.base_url}/${clean}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.api_key}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Emergent ${clean} failed (${res.status}): ${text.slice(0, 400)}`);
  }
  return (await res.json()) as T;
}

export async function pingEmergent(
  envId?: string,
): Promise<{ ok: boolean; status: number; message: string; env?: string }> {
  let cfg: Cached;
  try {
    cfg = await loadConfig();
  } catch (e) {
    if (e instanceof EmergentNotConfiguredError) {
      return { ok: false, status: 0, message: "Not configured." };
    }
    return { ok: false, status: 0, message: (e as Error).message };
  }
  let env: Env;
  try {
    env = pickEnv(cfg, envId);
  } catch {
    return { ok: false, status: 0, message: "Environment is missing URL or key." };
  }
  try {
    const res = await fetch(`${env.base_url}/health`, {
      headers: { Authorization: `Bearer ${env.api_key}` },
    });
    const text = await res.text().catch(() => "");
    return {
      ok: res.ok,
      status: res.status,
      env: env.id,
      message: res.ok ? "Connection OK" : text.slice(0, 300) || res.statusText,
    };
  } catch (e) {
    return { ok: false, status: 0, env: env.id, message: (e as Error).message };
  }
}

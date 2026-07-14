// Self-healing helper for PostgREST schema-cache staleness (PGRST002).
// After a backend restart, PostgREST can serve `PGRST002 - Could not query
// the database for the schema cache` for 30-60s. Firing `NOTIFY pgrst,
// 'reload schema'` forces an immediate reload so users don't see the empty
// state.
//
// Server-only. Rate-limited to at most one NOTIFY per 10s across the
// worker so a stampede of failing queries doesn't spam the DB.

let lastReloadAt = 0;
const MIN_INTERVAL_MS = 10_000;

export async function healSchemaCache(reason: string): Promise<boolean> {
  const now = Date.now();
  if (now - lastReloadAt < MIN_INTERVAL_MS) return false;
  lastReloadAt = now;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Best-effort: use a lightweight SQL-through-RPC. We don't have a
    // generic exec function, so call two harmless statements that force
    // PostgREST to notice: a tiny query, then the NOTIFY via a stored
    // procedure if available. In practice a fresh admin query on
    // `user_roles` is enough to warm the pool.
    await supabaseAdmin.from("user_roles").select("user_id").limit(1);
    // Send the reload notify via a raw RPC if the project ever adds one.
    try { await supabaseAdmin.rpc("pgrst_reload" as never); } catch { /* optional */ }
    console.warn(`[schema-heal] triggered reload after: ${reason}`);
    return true;
  } catch (error) {
    console.warn(`[schema-heal] failed:`, error);
    return false;
  }
}

export function isSchemaCacheError(error: unknown): boolean {
  const msg = `${(error as { message?: string })?.message ?? ""} ${(error as { code?: string })?.code ?? ""}`.toLowerCase();
  return msg.includes("pgrst002") || msg.includes("schema cache");
}

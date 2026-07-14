// Client-safe retry helper for PostgREST schema-cache staleness (PGRST002).
// Wrap a Supabase call so a transient "Could not query the database for the
// schema cache" during writes/reads is retried with exponential backoff
// instead of surfacing to the user as an ingest failure.

export function isSchemaCacheError(error: unknown): boolean {
  if (!error) return false;
  const msg = `${(error as { message?: string })?.message ?? ""} ${(error as { code?: string })?.code ?? ""}`.toLowerCase();
  return msg.includes("pgrst002")
    || msg.includes("pgrst205")
    || msg.includes("schema cache")
    || msg.includes("could not query the database for the schema");
}

/**
 * Retry `fn` up to `attempts` times when it fails with a PostgREST
 * schema-cache error. Backoff: 300ms, 800ms, 2000ms.
 */
export async function withSchemaHeal<T>(
  fn: () => Promise<T>,
  attempts = 4,
  label = "schema-heal",
): Promise<T> {
  const delays = [300, 800, 2000, 4000];
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isSchemaCacheError(error)) throw error;
      const wait = delays[Math.min(i, delays.length - 1)];
      // eslint-disable-next-line no-console
      console.warn(`[${label}] schema-cache stale (attempt ${i + 1}/${attempts}), retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}

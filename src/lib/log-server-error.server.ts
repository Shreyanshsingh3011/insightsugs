// Central server-side error logger. Server-only (filename-blocked from
// client bundles). Use inside createServerFn handlers and server routes
// via the `safeHandler` wrapper — or standalone when a handler needs
// to log but keep its original throw semantics.
//
// Design goals:
//   - Uniform structured log line for grep/analytics.
//   - Best-effort persistence to `audit_log` when a Supabase client is
//     available. Failures here are swallowed — logging must never mask
//     the original error.
//   - Redact obvious secrets (bearer tokens, API keys) from messages.

export type ErrorContext = {
  userId?: string | null;
  projectId?: string | null;
  extra?: Record<string, unknown>;
};

const SECRET_PATTERNS: RegExp[] = [
  /(bearer\s+)[a-z0-9._\-]{20,}/gi,
  /(sk-[a-z0-9]{16,})/gi,
  /(sb_secret_[a-z0-9]{16,})/gi,
  /eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{5,}/g,
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const rx of SECRET_PATTERNS) out = out.replace(rx, "[REDACTED]");
  return out;
}

function normalizeError(err: unknown): { message: string; stack?: string; name: string } {
  if (err instanceof Error) {
    return {
      message: redactSecrets(err.message || err.name),
      stack: err.stack ? redactSecrets(err.stack) : undefined,
      name: err.name,
    };
  }
  try {
    return { message: redactSecrets(JSON.stringify(err)), name: "NonErrorThrown" };
  } catch {
    return { message: "Unserializable error", name: "NonErrorThrown" };
  }
}

/**
 * Log a server-side error. Always safe to call — never throws.
 * `scope` is a short dotted identifier: `copilot.chat.stream`,
 * `sync.record`, `email.enqueue`, etc.
 */
export async function logServerError(
  scope: string,
  err: unknown,
  ctx: ErrorContext = {},
): Promise<void> {
  const norm = normalizeError(err);
  const payload = {
    scope,
    name: norm.name,
    message: norm.message,
    userId: ctx.userId ?? null,
    projectId: ctx.projectId ?? null,
    extra: ctx.extra ?? null,
    at: new Date().toISOString(),
  };

  // Structured console line — picked up by function logs.
  // eslint-disable-next-line no-console
  console.error(`[server-error] ${scope}`, JSON.stringify(payload), norm.stack ?? "");

  // Best-effort audit_log write. Never blocks or throws.
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("audit_log").insert({
      action: `error:${scope}`,
      actor_id: ctx.userId ?? null,
      target_type: "server_error",
      target_id: ctx.projectId ?? null,
      metadata: {
        name: norm.name,
        message: norm.message,
        extra: ctx.extra ?? null,
      },
    });
  } catch {
    /* swallow — logger must never surface secondary errors */
  }
}

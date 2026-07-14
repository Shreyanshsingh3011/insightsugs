// Shared authorization for public cron/webhook endpoints under
// src/routes/api/public/**. Historically each hook accepted the Supabase
// publishable/anon key as a valid bearer — but that key ships inside the
// browser bundle, so any visitor could trigger paid AI jobs, escalations,
// or DB writes. The single source of truth is now CRON_HOOK_SECRET plus,
// as a legitimate operator escape hatch, SUPABASE_SERVICE_ROLE_KEY.
//
// Callers (pg_cron / external schedulers) must send the secret in one of:
//   Header:  Authorization: Bearer <CRON_HOOK_SECRET>
//   Header:  apikey: <CRON_HOOK_SECRET>
//   Header:  x-cron-secret: <CRON_HOOK_SECRET>
//   Query:   ?apikey=<CRON_HOOK_SECRET>
//
// Comparison is constant-time to avoid timing side channels.

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// Only accept the shared cron secret over query string (low-risk, purpose-built).
// The service-role key must ONLY come from headers so it never leaks into
// access logs, proxies, or the Referer header.
function extractHeaderSecret(request: Request): string {
  const auth = request.headers.get("authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  return (
    request.headers.get("x-cron-secret") ??
    request.headers.get("apikey") ??
    request.headers.get("x-api-key") ??
    (bearer || "") ??
    ""
  );
}

function extractQuerySecret(request: Request): string {
  const url = new URL(request.url);
  return url.searchParams.get("apikey") ?? "";
}

export function isHookAuthorized(request: Request): boolean {
  const headerSecret = extractHeaderSecret(request);
  const querySecret = extractQuerySecret(request);

  const cronSecret = process.env.CRON_HOOK_SECRET ?? "";
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  // CRON_HOOK_SECRET may arrive via header OR query (pg_cron friendly).
  if (cronSecret) {
    if (headerSecret && timingSafeEqualStr(headerSecret, cronSecret)) return true;
    if (querySecret && timingSafeEqualStr(querySecret, cronSecret)) return true;
  }
  // SUPABASE_SERVICE_ROLE_KEY: header-only. Never accept via query string.
  if (serviceRole && headerSecret && timingSafeEqualStr(headerSecret, serviceRole)) return true;

  return false;
}

export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

/** Guard helper: returns a Response to short-circuit, or null to continue. */
export function requireHookAuth(request: Request): Response | null {
  return isHookAuthorized(request) ? null : unauthorizedResponse();
}

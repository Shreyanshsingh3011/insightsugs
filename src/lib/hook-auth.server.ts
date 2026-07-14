// Shared authorization for public cron/webhook endpoints under
// src/routes/api/public/**. Header-only — query strings leak into access
// logs, upstream proxies, and the Referer header, so we never read secrets
// from ?apikey= etc.
//
// Accepted headers (any one, in order of preference):
//   Authorization: Bearer <CRON_HOOK_SECRET>
//   x-cron-secret: <CRON_HOOK_SECRET>
//   apikey:        <CRON_HOOK_SECRET>
//   x-api-key:     <CRON_HOOK_SECRET>
//
// SUPABASE_SERVICE_ROLE_KEY is also accepted (header-only) as a legitimate
// operator escape hatch. Comparison is constant-time.

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function extractHeaderSecret(request: Request): string {
  const auth = request.headers.get("authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  return (
    bearer ||
    request.headers.get("x-cron-secret") ||
    request.headers.get("apikey") ||
    request.headers.get("x-api-key") ||
    ""
  );
}

export function isHookAuthorized(request: Request): boolean {
  const headerSecret = extractHeaderSecret(request);
  if (!headerSecret) return false;

  const cronSecret = process.env.CRON_HOOK_SECRET ?? "";
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  if (cronSecret && timingSafeEqualStr(headerSecret, cronSecret)) return true;
  if (serviceRole && timingSafeEqualStr(headerSecret, serviceRole)) return true;
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


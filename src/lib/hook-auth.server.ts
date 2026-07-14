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

function extractProvided(request: Request): string {
  const url = new URL(request.url);
  const auth = request.headers.get("authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  return (
    request.headers.get("x-cron-secret") ??
    request.headers.get("apikey") ??
    request.headers.get("x-api-key") ??
    (bearer || null) ??
    url.searchParams.get("apikey") ??
    url.searchParams.get("secret") ??
    ""
  );
}

export function isHookAuthorized(request: Request): boolean {
  const provided = extractProvided(request);
  if (!provided) return false;

  const cronSecret = process.env.CRON_HOOK_SECRET ?? "";
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  // Publishable/anon keys are intentionally NOT accepted — they are public.
  if (cronSecret && timingSafeEqualStr(provided, cronSecret)) return true;
  if (serviceRole && timingSafeEqualStr(provided, serviceRole)) return true;
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

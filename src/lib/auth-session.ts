import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

const TOKEN_EXPIRY_SKEW_SECONDS = 60;

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return JSON.parse(window.atob(padded));
  } catch {
    return null;
  }
}

function sessionExpiry(session: Session): number | null {
  if (typeof session.expires_at === "number") return session.expires_at;
  const payload = decodeJwtPayload(session.access_token);
  return typeof payload?.exp === "number" ? payload.exp : null;
}

export function isUsableSession(session: Session | null | undefined): session is Session {
  if (!session?.access_token || !session.user?.id) return false;
  if (session.access_token.split(".").length !== 3) return false;
  const expiresAt = sessionExpiry(session);
  if (!expiresAt) return true;
  return expiresAt > Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_SKEW_SECONDS;
}

export function readStoredSession(): Session | null {
  if (typeof window === "undefined") return null;
  for (const key of Object.keys(window.localStorage)) {
    if (!key.startsWith("sb-") || !key.endsWith("-auth-token")) continue;
    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null");
      const session = parsed?.currentSession ?? parsed;
      if (isUsableSession(session)) return session;
    } catch {
      // Ignore malformed storage entries and continue with the next auth key.
    }
  }
  return null;
}

export async function getUsableSupabaseSession(timeoutMs = 2500): Promise<Session | null> {
  const sessionResult = supabase.auth
    .getSession()
    .then(({ data }) => data.session)
    .catch(() => null);
  const fallback = new Promise<Session | null>((resolve) => {
    window.setTimeout(() => resolve(readStoredSession()), timeoutMs);
  });
  const session = await Promise.race([sessionResult, fallback]);
  return isUsableSession(session) ? session : null;
}
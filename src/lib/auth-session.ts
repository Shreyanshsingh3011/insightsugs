import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

const TOKEN_EXPIRY_SKEW_SECONDS = 60;
type SessionOptions = { validate?: boolean; strictValidation?: boolean; clearOnInvalid?: boolean };

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  if (typeof window === "undefined") return promise.catch(() => fallback);
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => window.setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const decoder = typeof window !== "undefined" ? window.atob : globalThis.atob;
    if (!decoder) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return JSON.parse(decoder(padded));
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

function isRefreshableSession(session: Session | null | undefined): session is Session {
  return !!session?.refresh_token && !!session.user?.id;
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

export function clearStoredSupabaseAuth() {
  if (typeof window === "undefined") return;
  for (const key of Object.keys(window.localStorage)) {
    if (key.startsWith("sb-") && key.endsWith("-auth-token")) {
      window.localStorage.removeItem(key);
    }
  }
}

// Single-flight refresh with 3x retry. Concurrent callers share the same
// in-flight promise so an auth-server 504 storm only produces one refresh.
let inflightRefresh: Promise<Session | null> | null = null;

async function refreshSession(timeoutMs: number): Promise<Session | null> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const refreshed = await withTimeout(
          supabase.auth.refreshSession().then(({ data }) => data.session),
          timeoutMs,
          null,
        );
        if (isUsableSession(refreshed)) return refreshed;
      } catch {
        // fall through and retry
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    return null;
  })().finally(() => {
    // Release the single-flight lock a tick later so a burst of callers
    // all see the same result before we allow a fresh attempt.
    setTimeout(() => { inflightRefresh = null; }, 250);
  });
  return inflightRefresh;
}

async function validateSession(session: Session, timeoutMs: number, strictValidation = false): Promise<Session | null> {
  const user = await withTimeout(
    supabase.auth.getUser(session.access_token).then(({ data, error }) => (error ? null : data.user)),
    timeoutMs,
    undefined,
  );

  if (user?.id) return session;
  if (user === undefined && !strictValidation) return session;
  return isRefreshableSession(session) ? refreshSession(timeoutMs) : null;
}

export async function getUsableSupabaseSession(timeoutMs = 2500, options: SessionOptions = {}): Promise<Session | null> {
  if (typeof window === "undefined") return null;
  const sessionResult = supabase.auth
    .getSession()
    .then(({ data }) => data.session)
    .catch(() => null);
  const fallback = new Promise<Session | null>((resolve) => {
    window.setTimeout(() => resolve(readStoredSession()), timeoutMs);
  });
  const session = await Promise.race([sessionResult, fallback]);

  const usableSession = isUsableSession(session)
    ? session
    : isRefreshableSession(session)
      ? await refreshSession(timeoutMs)
      : null;

  if (!usableSession) return null;
  if (!options.validate) return usableSession;

  const validatedSession = await validateSession(usableSession, timeoutMs, options.strictValidation);
  if (!validatedSession && options.clearOnInvalid !== false) {
    clearStoredSupabaseAuth();
  }
  return validatedSession;
}
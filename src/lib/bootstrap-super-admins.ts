export const BOOTSTRAP_SUPER_ADMIN_EMAILS = [
  "shreyansh.singh3011@gmail.com",
  "yash@sugslloyds.com",
  "r.sharma@sugslloyds.com",
] as const;

export const BOOTSTRAP_SUPER_ADMIN_USER_IDS = [
  "b530da41-caa8-4ead-b5fe-8eb3bc446ace",
] as const;

const bootstrapEmailSet = new Set<string>(BOOTSTRAP_SUPER_ADMIN_EMAILS);
const bootstrapUserIdSet = new Set<string>(BOOTSTRAP_SUPER_ADMIN_USER_IDS);

export function normalizeEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function isBootstrapSuperAdminEmail(email: unknown): boolean {
  return bootstrapEmailSet.has(normalizeEmail(email));
}

export function isBootstrapSuperAdminUserId(userId: unknown): boolean {
  return bootstrapUserIdSet.has(String(userId ?? ""));
}

export function readJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = typeof atob === "function"
      ? atob(padded)
      : Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export function emailFromJwtPayload(payload: Record<string, unknown> | null): string {
  const metadata = payload?.user_metadata as Record<string, unknown> | undefined;
  return normalizeEmail(
    (typeof payload?.email === "string" ? payload.email : "") ||
      (typeof metadata?.email === "string" ? metadata.email : ""),
  );
}

export function applyBootstrapSuperAdminRole(roles: string[], email: unknown, userId?: unknown): string[] {
  if (!isBootstrapSuperAdminEmail(email) && !isBootstrapSuperAdminUserId(userId)) return roles;
  return ["super_admin", ...roles.filter((role) => role !== "super_admin")];
}
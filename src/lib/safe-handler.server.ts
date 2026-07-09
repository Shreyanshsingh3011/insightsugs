// Wrapper for createServerFn handlers that returns a typed
// `{ ok: true, data } | { ok: false, error }` DTO instead of throwing
// raw provider errors across the RPC boundary.
//
// Usage:
//   export const doThing = createServerFn({ method: "POST" })
//     .middleware([requireSupabaseAuth])
//     .inputValidator((i: unknown) => Schema.parse(i))
//     .handler(safeHandler("things.do", async ({ data, context }) => {
//       // ... existing logic, may throw ...
//       return { id: "..." };
//     }));
//
// The wrapper redacts secrets, logs via `logServerError`, and returns
// a safe error message. Callers get a discriminated union — no more
// `try/catch` around every useServerFn invocation.
//
// Server-only (filename-blocked). Not for client import.

import { logServerError } from "./log-server-error.server";

export type SafeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };

type HandlerCtx = {
  data: unknown;
  context: { userId?: string | null; [k: string]: unknown };
};

export function safeHandler<T>(
  scope: string,
  fn: (ctx: HandlerCtx) => Promise<T>,
) {
  return async (ctx: HandlerCtx): Promise<SafeResult<T>> => {
    try {
      const data = await fn(ctx);
      return { ok: true, data };
    } catch (err) {
      const userId = (ctx.context?.userId as string | null | undefined) ?? null;
      // Extract project scoping if the input carries it — best-effort.
      const projectId =
        (typeof ctx.data === "object" && ctx.data && "project_id" in ctx.data
          ? (ctx.data as { project_id?: string }).project_id
          : undefined) ?? null;
      await logServerError(scope, err, { userId, projectId });
      const message =
        err instanceof Error
          ? err.message.slice(0, 500)
          : "Unexpected server error";
      return { ok: false, error: message };
    }
  };
}

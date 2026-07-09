// Frontend helper for running an async action with consistent
// error handling: toasts on failure, optional success toast, and
// a stable `running` flag for buttons.
//
// Replaces the pattern:
//   try { await doThing(...); toast.success(...); }
//   catch (e) { console.error(e); toast.error(...); }
//
// Works with both raw throwing async fns and `SafeResult`-returning
// server fns produced by `safeHandler`.

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

type SafeResultLike<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };

export type UseSafeActionOptions = {
  /** Toast shown on success. Omit to stay silent. */
  successMessage?: string;
  /** Prefix for the error toast. Defaults to "Action failed". */
  errorPrefix?: string;
  /** Called after success with the resolved value. */
  onSuccess?: (value: unknown) => void;
  /** Called after failure with the error message. */
  onError?: (message: string) => void;
};

export function useSafeAction<Args extends unknown[], R>(
  action: (...args: Args) => Promise<R | SafeResultLike<R>>,
  opts: UseSafeActionOptions = {},
) {
  const [running, setRunning] = useState(false);
  const inflight = useRef(false);

  const run = useCallback(
    async (...args: Args): Promise<R | null> => {
      if (inflight.current) return null;
      inflight.current = true;
      setRunning(true);
      try {
        const result = await action(...args);
        // If it's a SafeResult, unwrap.
        if (
          result &&
          typeof result === "object" &&
          "ok" in (result as object)
        ) {
          const sr = result as SafeResultLike<R>;
          if (!sr.ok) {
            const msg = `${opts.errorPrefix ?? "Action failed"}: ${sr.error}`;
            toast.error(msg);
            opts.onError?.(sr.error);
            return null;
          }
          if (opts.successMessage) toast.success(opts.successMessage);
          opts.onSuccess?.(sr.data);
          return sr.data;
        }
        if (opts.successMessage) toast.success(opts.successMessage);
        opts.onSuccess?.(result);
        return result as R;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        toast.error(`${opts.errorPrefix ?? "Action failed"}: ${message}`);
        opts.onError?.(message);
        // eslint-disable-next-line no-console
        console.error("[useSafeAction]", err);
        return null;
      } finally {
        inflight.current = false;
        setRunning(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [action, opts.successMessage, opts.errorPrefix],
  );

  return { run, running };
}

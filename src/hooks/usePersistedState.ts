import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useState that mirrors its value to sessionStorage so pagination/search/filter
 * choices survive when the user drills into a detail page and comes back.
 */
export function usePersistedState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const initialRef = useRef(initial);
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return initialRef.current;
    try {
      const raw = window.sessionStorage.getItem(key);
      if (raw == null) return initialRef.current;
      return JSON.parse(raw) as T;
    } catch {
      return initialRef.current;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* quota / SSR */ }
  }, [key, value]);

  const set = useCallback((v: T | ((prev: T) => T)) => setValue(v), []);
  return [value, set];
}

export default usePersistedState;

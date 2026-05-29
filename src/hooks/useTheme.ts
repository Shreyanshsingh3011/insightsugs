import { useEffect, useState, useCallback } from "react";

export type ThemeMode = "light" | "dark" | "system";

const KEY = "delaylens.theme";

function applyTheme(mode: ThemeMode) {
  if (typeof document === "undefined") return;
  const isDark =
    mode === "dark" ||
    (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", isDark);
}

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "light";
    return (localStorage.getItem(KEY) as ThemeMode) || "light";
  });

  useEffect(() => {
    applyTheme(mode);
  }, [mode]);

  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [mode]);

  const setMode = useCallback((m: ThemeMode) => {
    localStorage.setItem(KEY, m);
    setModeState(m);
  }, []);

  const toggle = useCallback(() => {
    setMode(document.documentElement.classList.contains("dark") ? "light" : "dark");
  }, [setMode]);

  return { mode, setMode, toggle };
}

// Init script: must run before React hydrates to avoid flash.
export const THEME_INIT_SCRIPT = `(function(){try{var m=localStorage.getItem('${KEY}')||'light';var d=m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark');}catch(e){}})();`;

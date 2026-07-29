// Hook for toggling/reading QA test-fixture scenarios in non-production
// environments.

import { useEffect, useState, useCallback } from "react";
import type { QaScenarioId } from "@/lib/qa-fixtures";

const KEY = "qa:scenario";
const EVT = "qa:scenario:change";

function read(): QaScenarioId {
  if (typeof window === "undefined") return "off";
  return (localStorage.getItem(KEY) as QaScenarioId | null) || "off";
}

/** Reactive read of the active QA scenario. Updates in-tab and cross-tab. */
export function useQaScenario(): [QaScenarioId, (id: QaScenarioId) => void] {
  const [id, setId] = useState<QaScenarioId>(read);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onChange = () => setId(read());
    window.addEventListener(EVT, onChange);
    window.addEventListener("storage", (e) => { if (e.key === KEY) onChange(); });
    return () => window.removeEventListener(EVT, onChange);
  }, []);
  const set = useCallback((next: QaScenarioId) => {
    if (typeof window === "undefined") return;
    if (next === "off") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
    window.dispatchEvent(new Event(EVT));
  }, []);
  return [id, set];
}

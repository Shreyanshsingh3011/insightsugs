import { useCallback, useEffect, useState } from "react";

export type WidgetId =
  | "summary"
  | "kpi"
  | "charts"
  | "rankings"
  | "tat"
  | "flags"
  | "dependencies"
  | "feed";

export type WidgetConfig = { id: WidgetId; label: string; visible: boolean };

export const DEFAULT_WIDGETS: WidgetConfig[] = [
  { id: "summary", label: "Summary", visible: true },
  { id: "kpi", label: "KPI cards", visible: true },
  { id: "charts", label: "Charts (status, reasons, risk)", visible: true },
  { id: "rankings", label: "People & department rankings", visible: true },
  { id: "tat", label: "TAT performance table", visible: true },
  { id: "flags", label: "Flags panel", visible: true },
  { id: "dependencies", label: "Dependency chain", visible: true },
  { id: "feed", label: "Data feed", visible: true },
];

const KEY = "delaylens.widgets.v1";

function load(): WidgetConfig[] {
  if (typeof window === "undefined") return DEFAULT_WIDGETS;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_WIDGETS;
    const parsed = JSON.parse(raw) as WidgetConfig[];
    // Merge: keep saved order/visibility but ensure all default ids are present.
    const map = new Map(parsed.map((w) => [w.id, w]));
    const merged: WidgetConfig[] = [];
    for (const w of parsed) {
      const def = DEFAULT_WIDGETS.find((d) => d.id === w.id);
      if (def) merged.push({ ...def, visible: w.visible });
    }
    for (const d of DEFAULT_WIDGETS) {
      if (!map.has(d.id)) merged.push(d);
    }
    return merged;
  } catch {
    return DEFAULT_WIDGETS;
  }
}

export function useDashboardWidgets() {
  const [widgets, setWidgets] = useState<WidgetConfig[]>(DEFAULT_WIDGETS);

  useEffect(() => {
    setWidgets(load());
  }, []);

  const save = useCallback((next: WidgetConfig[]) => {
    setWidgets(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
  }, []);

  const toggle = useCallback((id: WidgetId) => {
    save(widgets.map((w) => (w.id === id ? { ...w, visible: !w.visible } : w)));
  }, [widgets, save]);

  const reorder = useCallback((from: number, to: number) => {
    const next = widgets.slice();
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    save(next);
  }, [widgets, save]);

  const reset = useCallback(() => {
    save(DEFAULT_WIDGETS);
  }, [save]);

  return { widgets, toggle, reorder, reset, save };
}

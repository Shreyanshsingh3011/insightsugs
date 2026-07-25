import { useState } from "react";
import { FlaskConical, X, Check } from "lucide-react";
import { useIsAdmin } from "@/hooks/useSession";
import { useQaScenario } from "@/hooks/useQaScenario";
import { QA_SCENARIOS } from "@/lib/qa-fixtures";

/**
 * Floating QA data switcher. Admin-only. Swaps live sheet data for
 * synthetic edge-case fixtures (empty, 50 alerts, 500 rows, date-serial
 * leaks, missing owners, no-delays) so data-dependent bugs are reproducible
 * on demand. Uses the same data pipeline as production — the override
 * happens inside useAgentSources before decoration/scoping.
 */
export function QaDataSwitcher() {
  const isAdmin = useIsAdmin();
  const [scenario, setScenario] = useQaScenario();
  const [open, setOpen] = useState(false);

  if (!isAdmin) return null;

  const active = scenario !== "off";
  const activeLabel = QA_SCENARIOS.find((s) => s.id === scenario)?.label ?? "Live";

  return (
    <div className="fixed bottom-4 right-4 z-40 print:hidden">
      {open && (
        <div className="mb-2 w-80 rounded-xl border border-border bg-card p-3 shadow-elevated">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <FlaskConical className="h-4 w-4 text-brand" />
              QA data scenarios
            </div>
            <button
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Close QA switcher"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            Swap live sheet data for a synthetic fixture. Affects dashboard, alerts, KPIs, briefings — everything using the sources pipeline.
          </p>
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {QA_SCENARIOS.map((s) => {
              const selected = s.id === scenario;
              return (
                <li key={s.id}>
                  <button
                    onClick={() => setScenario(s.id)}
                    className={`flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${
                      selected
                        ? "border-primary bg-accent"
                        : "border-transparent hover:bg-accent/50"
                    }`}
                  >
                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                      {selected && <Check className="h-4 w-4 text-primary" />}
                    </span>
                    <span className="flex-1">
                      <span className="block text-xs font-medium">{s.label}</span>
                      <span className="block text-[11px] leading-snug text-muted-foreground">{s.description}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-card transition-colors ${
          active
            ? "border-brand bg-brand text-brand-foreground hover:opacity-90"
            : "border-border bg-card text-foreground hover:bg-accent"
        }`}
        title={active ? `Active QA scenario: ${activeLabel}` : "Open QA data switcher"}
      >
        <FlaskConical className="h-3.5 w-3.5" />
        {active ? `QA: ${activeLabel}` : "QA data"}
      </button>
    </div>
  );
}

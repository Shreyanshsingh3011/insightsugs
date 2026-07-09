// Dev-only fixture page used by scripts/tests/citation-panel-ui.py to snapshot
// and interaction-test the refusal card + citation side panel. Renders the
// same visual pieces (refusal card markup + chip buttons + CitationPanel)
// used inside AgentChatWidget so we can drive them without a live chat run.
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { CitationPanel, type CitationTarget } from "@/components/CitationPanel";
import { FileText } from "lucide-react";

export const Route = createFileRoute("/dev/citations")({
  component: DevCitationsFixture,
});

function DevCitationsFixture() {
  const [selected, setSelected] = useState<CitationTarget | null>(null);
  return (
    <div className="p-6 space-y-4 max-w-xl mx-auto">
      <h1 className="text-lg font-semibold">Citation UI fixture</h1>

      <div data-testid="refusal-card" className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
        <div className="font-medium text-amber-700 dark:text-amber-300">
          Not found in your dashboard data
        </div>
        <div className="mt-1 text-muted-foreground">To answer this I'd need:</div>
        <ul className="mt-1 list-disc pl-4 space-y-0.5">
          <li>Q3 revenue by region</li>
          <li>Sheet: Forecasts 2027</li>
        </ul>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          data-testid="citation-chip-sheet"
          onClick={() => setSelected({ kind: "sheet", label: "Projects Master", row: 12 })}
          className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-[10px] text-primary hover:bg-primary/10"
        >
          <FileText className="h-3 w-3" /> Projects Master · row 12
        </button>
        <button
          type="button"
          data-testid="citation-chip-doc"
          onClick={() => setSelected({ kind: "doc", label: "Kickoff Notes", page: 3 })}
          className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/5 px-2 py-0.5 text-[10px]"
        >
          <FileText className="h-3 w-3" /> Kickoff Notes · p.3
        </button>
        <button
          type="button"
          data-testid="citation-chip-dashboard"
          onClick={() => setSelected({ kind: "dashboard", field: "overdue_count", value: 7 })}
          className="inline-flex items-center gap-1 rounded-full border border-muted-foreground/30 bg-muted/40 px-2 py-0.5 text-[10px]"
        >
          dashboard · overdue_count
        </button>
      </div>

      <CitationPanel target={selected} onOpenChange={(o) => !o && setSelected(null)} />
    </div>
  );
}

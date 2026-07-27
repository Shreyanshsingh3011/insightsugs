// Citation chip strip for a single assistant answer.
// Extracted out of AgentChatWidget so the chips can be filtered by kind,
// searched by label/field, and stepped through with prev/next jump controls.
import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Search, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AnyCitation } from "@/lib/citation-parser";
import type { CitationTarget } from "@/components/CitationPanel";

type KindFilter = "all" | "sheet" | "doc" | "dashboard";

function chipLabel(c: AnyCitation): string {
  if (c.kind === "sheet") return `${c.label} · row ${c.row}`;
  if (c.kind === "doc") return `${c.label} · p.${c.page}`;
  return `dashboard · ${c.field}`;
}

function chipKey(c: AnyCitation): string {
  if (c.kind === "sheet") return `s:${c.label}:${c.row}`;
  if (c.kind === "doc") return `d:${c.label}:${c.page}`;
  return `x:${c.field}`;
}

export function CitationChips({
  citations,
  onSelect,
  selected,
  resolveDashboardValue,
}: {
  citations: AnyCitation[];
  onSelect: (t: CitationTarget) => void;
  selected?: CitationTarget | null;
  resolveDashboardValue?: (field: string) => unknown;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const listRef = useRef<HTMLDivElement>(null);

  const counts = useMemo(() => {
    const c = { all: citations.length, sheet: 0, doc: 0, dashboard: 0 };
    for (const x of citations) c[x.kind] += 1;
    return c;
  }, [citations]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return citations.filter((c) => {
      if (kind !== "all" && c.kind !== kind) return false;
      if (!q) return true;
      return chipLabel(c).toLowerCase().includes(q);
    });
  }, [citations, kind, query]);

  const toTarget = (c: AnyCitation): CitationTarget => {
    if (c.kind === "sheet") return { kind: "sheet", label: c.label, row: c.row };
    if (c.kind === "doc") return { kind: "doc", label: c.label, page: c.page };
    return { kind: "dashboard", field: c.field, value: resolveDashboardValue?.(c.field) };
  };

  const selectedKey = useMemo(() => {
    if (!selected) return null;
    if (selected.kind === "sheet") return `s:${selected.label}:${selected.row}`;
    if (selected.kind === "doc") return `d:${selected.label}:${selected.page}`;
    return `x:${selected.field}`;
  }, [selected]);

  const activeIndex = visible.findIndex((c) => chipKey(c) === selectedKey);

  // Keep the active chip scrolled into view when jumping with prev/next.
  useEffect(() => {
    if (activeIndex < 0 || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-chip-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeIndex]);

  const jump = (delta: number) => {
    if (visible.length === 0) return;
    const base = activeIndex < 0 ? (delta > 0 ? -1 : 0) : activeIndex;
    const next = (base + delta + visible.length) % visible.length;
    onSelect(toTarget(visible[next]));
  };

  if (citations.length === 0) return null;

  const filters: { key: KindFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "sheet", label: "Rows" },
    { key: "doc", label: "Docs" },
    { key: "dashboard", label: "Fields" },
  ];

  return (
    <div className="space-y-1.5" data-testid="citation-chips">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Sources
        </span>
        {filters.map((f) => {
          const n = counts[f.key];
          if (f.key !== "all" && n === 0) return null;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setKind(f.key)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] transition",
                kind === f.key
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border bg-transparent text-muted-foreground hover:bg-muted",
              )}
            >
              {f.label} {n}
            </button>
          );
        })}

        <div className="ml-auto flex items-center gap-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter sources"
              aria-label="Filter cited sources"
              data-testid="citation-search"
              className="h-6 w-32 rounded-full border border-border bg-background pl-6 pr-5 text-[10px] outline-none focus:border-primary/50"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear filter"
                onClick={() => setQuery("")}
                className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <button
            type="button"
            aria-label="Previous cited source"
            data-testid="citation-prev"
            disabled={visible.length === 0}
            onClick={() => jump(-1)}
            className="rounded border border-border p-0.5 text-muted-foreground transition hover:bg-muted disabled:opacity-40"
          >
            <ChevronLeft className="h-3 w-3" />
          </button>
          <span className="min-w-[2.5rem] text-center text-[10px] tabular-nums text-muted-foreground">
            {visible.length === 0 ? "0/0" : `${activeIndex < 0 ? 0 : activeIndex + 1}/${visible.length}`}
          </span>
          <button
            type="button"
            aria-label="Next cited source"
            data-testid="citation-next"
            disabled={visible.length === 0}
            onClick={() => jump(1)}
            className="rounded border border-border p-0.5 text-muted-foreground transition hover:bg-muted disabled:opacity-40"
          >
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div ref={listRef} className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
        {visible.length === 0 ? (
          <span className="text-[10px] text-muted-foreground">No cited sources match "{query}".</span>
        ) : (
          visible.map((c, idx) => {
            const isActive = idx === activeIndex;
            const common = cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition",
              isActive && "ring-1 ring-primary ring-offset-1 ring-offset-background",
            );
            if (c.kind === "sheet") {
              return (
                <button
                  key={chipKey(c)}
                  type="button"
                  data-chip-index={idx}
                  data-testid="citation-chip-sheet"
                  onClick={() => onSelect(toTarget(c))}
                  className={cn(common, "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10")}
                  title={`Open sheet "${c.label}" row ${c.row}`}
                >
                  <FileText className="h-3 w-3" aria-hidden />
                  {c.label} · row {c.row}
                </button>
              );
            }
            if (c.kind === "doc") {
              return (
                <button
                  key={chipKey(c)}
                  type="button"
                  data-chip-index={idx}
                  data-testid="citation-chip-doc"
                  onClick={() => onSelect(toTarget(c))}
                  className={cn(common, "border-accent/30 bg-accent/5 text-foreground hover:bg-accent/10")}
                  title={`Open document "${c.label}" p.${c.page}`}
                >
                  <FileText className="h-3 w-3" aria-hidden />
                  {c.label} · p.{c.page}
                </button>
              );
            }
            return (
              <button
                key={chipKey(c)}
                type="button"
                data-chip-index={idx}
                data-testid="citation-chip-dashboard"
                onClick={() => onSelect(toTarget(c))}
                className={cn(common, "border-muted-foreground/30 bg-muted/40 text-foreground hover:bg-muted")}
                title={`Inspect dashboard field "${c.field}"`}
              >
                dashboard · {c.field}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

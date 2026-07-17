import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Database,
  Columns3,
  Gavel,
  FileText as FileIcon,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import type { ToolCall } from "@/components/copilot/ToolCallTrace";

type Source = {
  id?: string;
  title?: string;
  name?: string;
  kind?: string;
  type?: string;
  sheetLabel?: string;
  documentName?: string;
  rowIndex?: number;
  pageNo?: number;
};

type Diagnostic = {
  sourceId: string;
  sourceName: string;
  sourceType: "sheet" | "document";
  matcherPath?: string;
  rowsScanned?: number;
  rowsMatched?: number;
  columnsSearched?: string[];
  missingColumns?: string[];
  derivedFields?: string[];
  reason?: string;
};

export function GroundingTracePanel({
  sources,
  diagnostics,
  toolTrace,
  citationOk,
  unmatchedTerms,
}: {
  sources?: Source[];
  diagnostics?: Diagnostic[];
  toolTrace?: ToolCall[];
  citationOk?: boolean;
  unmatchedTerms?: string[];
}) {
  const [open, setOpen] = useState(false);

  const { sheetsUsed, docsUsed, fields, rules } = useMemo(() => {
    // Sheets — dedupe by sheetLabel/name from sources + diagnostics
    const sheetMap = new Map<string, { label: string; rows: number }>();
    const docMap = new Map<string, { label: string; pages: Set<number> }>();
    for (const s of sources ?? []) {
      const label = s.sheetLabel || s.title || s.name || "";
      const kind = (s.kind || s.type || "").toLowerCase();
      if (label && (kind.includes("sheet") || kind === "row" || s.rowIndex != null)) {
        const rec = sheetMap.get(label) ?? { label, rows: 0 };
        rec.rows += 1;
        sheetMap.set(label, rec);
      } else if (label && (kind.includes("doc") || s.pageNo != null || s.documentName)) {
        const key = s.documentName || label;
        const rec = docMap.get(key) ?? { label: key, pages: new Set<number>() };
        if (typeof s.pageNo === "number") rec.pages.add(s.pageNo);
        docMap.set(key, rec);
      }
    }
    for (const d of diagnostics ?? []) {
      if (d.sourceType === "sheet" && d.sourceName) {
        const rec = sheetMap.get(d.sourceName) ?? { label: d.sourceName, rows: 0 };
        if (d.rowsMatched != null) rec.rows = Math.max(rec.rows, d.rowsMatched);
        sheetMap.set(d.sourceName, rec);
      }
    }

    // Fields — union of columnsSearched + derivedFields per source
    const fieldRows = (diagnostics ?? [])
      .filter((d) => (d.columnsSearched?.length ?? 0) + (d.derivedFields?.length ?? 0) > 0)
      .map((d) => ({
        source: d.sourceName,
        columns: d.columnsSearched ?? [],
        derived: d.derivedFields ?? [],
        missing: d.missingColumns ?? [],
      }));

    // Rules — inferred from tool trace + flags
    const ruleSet: { label: string; ok: boolean; detail?: string }[] = [];
    const seen = new Set<string>();
    const addRule = (label: string, ok: boolean, detail?: string) => {
      if (seen.has(label)) return;
      seen.add(label);
      ruleSet.push({ label, ok, detail });
    };
    const traceNames = new Set((toolTrace ?? []).map((t) => t.name));
    if (traceNames.has("get_cell")) addRule("Pin-to-cell lookup", true, "Fetched exact source cell");
    if (traceNames.has("date_query_rows")) addRule("Temporal pre-flight", true, "Applied date-window filter");
    if (traceNames.has("filter_rows") || traceNames.has("query_rows"))
      addRule("Exact-match guardrail", true, "Scored ID/name against columns");
    if (traceNames.has("summarize_sheet") || traceNames.has("sheet_stats"))
      addRule("Deterministic stats", true, "Computed without LLM");
    if (traceNames.has("search_docs")) addRule("Document retrieval", true, "Retrieved doc chunks");
    if (traceNames.has("clarify")) addRule("Clarify-first policy", true, "Asked for disambiguation");
    if ((diagnostics ?? []).some((d) => (d.derivedFields?.length ?? 0) > 0))
      addRule("Derived-field synthesis", true, "Used effectivelyDone / TAT logic");
    addRule(
      "Citation enforcement",
      !!citationOk,
      citationOk ? "Every claim cites a row/page" : "Answer flagged — missing citations",
    );
    if ((unmatchedTerms ?? []).length > 0)
      addRule("Unmatched-term surfacing", true, `Flagged: ${unmatchedTerms!.slice(0, 3).join(", ")}`);

    return {
      sheetsUsed: Array.from(sheetMap.values()),
      docsUsed: Array.from(docMap.values()),
      fields: fieldRows,
      rules: ruleSet,
    };
  }, [sources, diagnostics, toolTrace, citationOk, unmatchedTerms]);

  const hasAnything =
    sheetsUsed.length > 0 || docsUsed.length > 0 || fields.length > 0 || rules.length > 0;
  if (!hasAnything) return null;

  return (
    <div className="mb-2 rounded-md border border-border/60 bg-muted/20 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span className="font-medium">Grounding trace</span>
        <span className="opacity-70">
          {sheetsUsed.length} sheet{sheetsUsed.length === 1 ? "" : "s"} ·{" "}
          {docsUsed.length} doc{docsUsed.length === 1 ? "" : "s"} · {rules.length} rule
          {rules.length === 1 ? "" : "s"}
        </span>
        {citationOk === false ? (
          <AlertTriangle className="ml-auto h-3.5 w-3.5 text-amber-600" />
        ) : (
          <CheckCircle2 className="ml-auto h-3.5 w-3.5 text-emerald-600" />
        )}
      </button>

      {open && (
        <div className="space-y-3 px-3 pb-3 pt-1">
          {(sheetsUsed.length > 0 || docsUsed.length > 0) && (
            <Section icon={<Database className="h-3.5 w-3.5" />} title="Sources used">
              <ul className="space-y-1">
                {sheetsUsed.map((s) => (
                  <li key={`sh-${s.label}`} className="flex items-center gap-2">
                    <Database className="h-3 w-3 text-muted-foreground" />
                    <span className="font-mono">{s.label}</span>
                    {s.rows > 0 && (
                      <span className="text-muted-foreground">· {s.rows} row{s.rows === 1 ? "" : "s"}</span>
                    )}
                  </li>
                ))}
                {docsUsed.map((d) => (
                  <li key={`dc-${d.label}`} className="flex items-center gap-2">
                    <FileIcon className="h-3 w-3 text-muted-foreground" />
                    <span className="font-mono">{d.label}</span>
                    {d.pages.size > 0 && (
                      <span className="text-muted-foreground">
                        · p.{Array.from(d.pages).sort((a, b) => a - b).join(", ")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {fields.length > 0 && (
            <Section icon={<Columns3 className="h-3.5 w-3.5" />} title="Fields referenced">
              <ul className="space-y-1.5">
                {fields.map((f, i) => (
                  <li key={i}>
                    <div className="font-mono text-[0.7rem] text-muted-foreground">{f.source}</div>
                    {f.columns.length > 0 && (
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {f.columns.map((c) => (
                          <span
                            key={c}
                            className="rounded bg-background px-1.5 py-0.5 font-mono text-[0.68rem]"
                          >
                            {c}
                          </span>
                        ))}
                      </div>
                    )}
                    {f.derived.length > 0 && (
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {f.derived.map((c) => (
                          <span
                            key={c}
                            className="rounded border border-dashed border-border px-1.5 py-0.5 font-mono text-[0.68rem] text-muted-foreground"
                            title="Derived field"
                          >
                            ƒ {c}
                          </span>
                        ))}
                      </div>
                    )}
                    {f.missing.length > 0 && (
                      <div className="mt-0.5 text-[0.68rem] text-amber-700 dark:text-amber-400">
                        missing: {f.missing.join(", ")}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {rules.length > 0 && (
            <Section icon={<Gavel className="h-3.5 w-3.5" />} title="Rules applied">
              <ul className="space-y-1">
                {rules.map((r) => (
                  <li key={r.label} className="flex items-start gap-2">
                    {r.ok ? (
                      <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                    ) : (
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" />
                    )}
                    <div>
                      <div className="font-medium">{r.label}</div>
                      {r.detail && (
                        <div className="text-[0.68rem] text-muted-foreground">{r.detail}</div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

import { useState } from "react";
import { ChevronDown, ChevronRight, Check, X, Wrench } from "lucide-react";

export type ToolCall = {
  name: string;
  args: any;
  ok: boolean;
  ms: number;
  summary: string;
  result?: any;
};

export function ToolCallTrace({ trace }: { trace: ToolCall[] }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  if (!trace || trace.length === 0) return null;

  const ok = trace.every((t) => t.ok);
  const totalMs = trace.reduce((a, b) => a + (b.ms ?? 0), 0);

  return (
    <div className="mb-2 rounded-md border border-border/60 bg-muted/30 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Wrench className="h-3.5 w-3.5" />
        <span className="font-medium">Grounding · {trace.length} tool call{trace.length === 1 ? "" : "s"}</span>
        <span className="text-[0.7rem] opacity-70">{totalMs}ms</span>
        {ok ? (
          <Check className="ml-auto h-3.5 w-3.5 text-emerald-600" />
        ) : (
          <X className="ml-auto h-3.5 w-3.5 text-destructive" />
        )}
      </button>
      {open && (
        <ol className="divide-y divide-border/60 px-2 pb-2">
          {trace.map((t, i) => (
            <li key={i} className="py-1.5">
              <button
                type="button"
                onClick={() => setExpanded(expanded === i ? null : i)}
                className="flex w-full items-start gap-2 text-left"
              >
                {t.ok ? (
                  <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                ) : (
                  <X className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-[0.72rem]">
                    {t.name}({renderArgs(t.args)}) <span className="text-muted-foreground">→ {t.summary}</span>
                  </div>
                </div>
                <span className="shrink-0 text-[0.7rem] text-muted-foreground">{t.ms}ms</span>
              </button>
              {expanded === i && t.result != null && (
                <pre className="mt-1 max-h-64 overflow-auto rounded bg-background/50 p-2 text-[0.7rem]">
                  {safeStringify(t.result)}
                </pre>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function renderArgs(args: any): string {
  if (args == null) return "";
  if (typeof args !== "object") return String(args);
  const bits: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    const s = typeof v === "string" ? `"${v.slice(0, 40)}"` : JSON.stringify(v);
    bits.push(`${k}=${s}`);
  }
  return bits.join(", ");
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2).slice(0, 4000);
  } catch {
    return String(v);
  }
}

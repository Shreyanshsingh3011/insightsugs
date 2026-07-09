// Side panel that opens when a user clicks a citation chip in the chat.
// Shows the exact referenced row / doc excerpt / dashboard field snapshot
// used to ground the assistant's answer.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { getCitationContext, type CitationContext } from "@/lib/citations.functions";
import { FileText, Loader2, ExternalLink } from "lucide-react";

export type CitationTarget =
  | { kind: "sheet"; label: string; row: number }
  | { kind: "doc"; label: string; page: number }
  | { kind: "dashboard"; field: string; value?: unknown };

export function CitationPanel({
  target,
  onOpenChange,
}: {
  target: CitationTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const fetchCtx = useServerFn(getCitationContext);
  const [loading, setLoading] = useState(false);
  const [ctx, setCtx] = useState<CitationContext | null>(null);

  useEffect(() => {
    setCtx(null);
    if (!target || target.kind === "dashboard") return;
    let alive = true;
    setLoading(true);
    fetchCtx({
      data:
        target.kind === "sheet"
          ? { kind: "sheet", label: target.label, row: target.row }
          : { kind: "doc", label: target.label, page: target.page },
    })
      .then((r) => alive && setCtx(r as CitationContext))
      .catch(() => alive && setCtx(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [target, fetchCtx]);

  return (
    <Sheet open={!!target} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            {target?.kind === "sheet" && `Sheet: ${target.label} · row ${target.row}`}
            {target?.kind === "doc" && `Document: ${target.label} · p.${target.page}`}
            {target?.kind === "dashboard" && `Dashboard: ${target.field}`}
          </SheetTitle>
          <SheetDescription>Exact source used to ground this answer.</SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-3 text-sm">
          {target?.kind === "dashboard" && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">Value at query time</div>
              <pre className="rounded bg-muted p-2 text-xs whitespace-pre-wrap break-all">
                {formatValue(target.value)}
              </pre>
              <p className="mt-3 text-xs text-muted-foreground">
                This is the current dashboard aggregate the assistant read from your live snapshot.
              </p>
            </div>
          )}

          {target?.kind !== "dashboard" && loading && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading source…
            </div>
          )}

          {ctx && ctx.kind === "sheet" && (
            <div className="space-y-3">
              {!ctx.found && (
                <div className="rounded border border-destructive/30 bg-destructive/5 p-2 text-xs">
                  Row not found in your current data. It may have been removed or renamed.
                </div>
              )}
              {ctx.sheet && (
                <div className="text-xs text-muted-foreground">
                  Last refreshed: {ctx.sheet.last_refreshed_at ?? "unknown"}
                  {ctx.sheet.source_url && (
                    <a
                      href={ctx.sheet.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-2 inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      open source <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              )}
              {ctx.canonical && (
                <KeyValueTable title="Canonical fields" data={ctx.canonical} />
              )}
              {ctx.extras && Object.keys(ctx.extras).length > 0 && (
                <KeyValueTable title="Extras" data={ctx.extras} />
              )}
            </div>
          )}

          {ctx && ctx.kind === "doc" && (
            <div className="space-y-2">
              {!ctx.found && (
                <div className="rounded border border-destructive/30 bg-destructive/5 p-2 text-xs">
                  Document not found in your library.
                </div>
              )}
              {ctx.doc && (
                <>
                  <div className="text-xs text-muted-foreground">
                    Page {target?.kind === "doc" ? target.page : ""} of {ctx.doc.page_count ?? "?"}
                  </div>
                  {ctx.doc.summary && (
                    <div>
                      <div className="text-xs font-medium mb-1">Summary</div>
                      <p className="text-xs leading-relaxed">{ctx.doc.summary}</p>
                    </div>
                  )}
                  {Array.isArray(ctx.key_points) && ctx.key_points.length > 0 && (
                    <div>
                      <div className="text-xs font-medium mb-1">Key points</div>
                      <ul className="list-disc pl-4 text-xs space-y-1">
                        {(ctx.key_points as unknown[]).slice(0, 12).map((kp, i) => (
                          <li key={i}>{typeof kp === "string" ? kp : JSON.stringify(kp)}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return "(not captured)";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function KeyValueTable({ title, data }: { title: string; data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== "" && v !== undefined);
  if (entries.length === 0) return null;
  return (
    <div>
      <div className="text-xs font-medium mb-1">{title}</div>
      <div className="rounded border overflow-hidden">
        <table className="w-full text-xs">
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k} className="border-b last:border-0">
                <td className="px-2 py-1 bg-muted/40 font-medium align-top w-1/3">{k}</td>
                <td className="px-2 py-1 break-words">
                  {typeof v === "object" ? JSON.stringify(v) : String(v)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Sparkles, FileText } from "lucide-react";
import { listSheets, askCopilot } from "@/lib/sheets.functions";
import { listDocuments } from "@/lib/documents.functions";
import { SHEET_TYPE_LABELS, type SheetType } from "@/lib/sheets-schemas";

export const Route = createFileRoute("/_authenticated/copilot")({
  component: CopilotPage,
});

type Source = { id: string; name: string; type: string; rowsUsed: number; truncated: boolean };
type Turn = { question: string; answer: string; sources: Source[] };

function CopilotPage() {
  const fetchList = useServerFn(listSheets);
  const fetchDocs = useServerFn(listDocuments);
  const ask = useServerFn(askCopilot);

  const sheets = useQuery({ queryKey: ["sheets-list"], queryFn: () => fetchList() });
  const documents = useQuery({
    queryKey: ["copilot-documents"],
    queryFn: () => fetchDocs({ data: {} }),
  });

  const [question, setQuestion] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<Turn[]>([]);

  const askMut = useMutation({
    mutationFn: () =>
      ask({
        data: {
          question: question.trim(),
          sheetIds: Array.from(selected),
          documentIds: Array.from(selectedDocs),
        },
      }),
    onSuccess: (res) => {
      setHistory((h) => [
        ...h,
        { question: question.trim(), answer: res.answer, sources: res.sources },
      ]);
      setQuestion("");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "AI request failed"),
  });

  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleDoc = (id: string) => {
    setSelectedDocs((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const canSend =
    question.trim().length > 0 &&
    (selected.size > 0 || selectedDocs.size > 0) &&
    !askMut.isPending;

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4 p-4 md:grid-cols-[260px_1fr] md:p-6">
      {/* Sidebar: sheet + document picker */}
      <aside className="space-y-3">
        <Card className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium">Sheets in context</h2>
            <span className="text-xs text-muted-foreground">{selected.size} selected</span>
          </div>
          {sheets.isLoading ? (
            <div className="flex justify-center py-4 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : (sheets.data?.sheets ?? []).length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">
              Register sheets first on the My Sheets page.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {sheets.data!.sheets.map((s: any) => (
                <li key={s.id}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-muted/50">
                    <Checkbox
                      checked={selected.has(s.id)}
                      onCheckedChange={() => toggle(s.id)}
                      className="mt-0.5"
                    />
                    <div className="min-w-0">
                      <div className="truncate text-sm">{s.display_name}</div>
                      <div className="text-xs text-muted-foreground">
                        {SHEET_TYPE_LABELS[s.sheet_type as SheetType]} · {s.row_count} rows
                      </div>
                    </div>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-medium">
              <FileText className="h-3.5 w-3.5" /> Documents
            </h2>
            <span className="text-xs text-muted-foreground">{selectedDocs.size} selected</span>
          </div>
          {documents.isLoading ? (
            <div className="flex justify-center py-4 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : (documents.data?.documents ?? []).length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">
              Upload documents on the Documents page.
            </p>
          ) : (
            <ul className="max-h-64 space-y-1.5 overflow-y-auto">
              {documents.data!.documents.map((d: any) => (
                <li key={d.id}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-muted/50">
                    <Checkbox
                      checked={selectedDocs.has(d.id)}
                      onCheckedChange={() => toggleDoc(d.id)}
                      disabled={d.status !== "ready"}
                      className="mt-0.5"
                    />
                    <div className="min-w-0">
                      <div className="truncate text-sm">{d.name}</div>
                      <div className="text-xs text-muted-foreground capitalize">
                        {d.status}
                        {d.page_count ? ` · ${d.page_count} pages` : ""}
                      </div>
                    </div>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </aside>


      {/* Conversation */}
      <section className="flex min-h-[60vh] flex-col gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Sparkles className="h-5 w-5 text-primary" /> Copilot
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Ask anything about the sheets you've selected. Answers are based only on that data.
          </p>
        </div>

        <div className="flex-1 space-y-4">
          {history.length === 0 && !askMut.isPending ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              Select one or more sheets on the left, then ask a question below.
            </Card>
          ) : (
            history.map((t, i) => (
              <div key={i} className="space-y-2">
                <Card className="bg-muted/40 p-3 text-sm">
                  <div className="mb-1 text-xs font-medium text-muted-foreground">You</div>
                  {t.question}
                </Card>
                <Card className="p-3 text-sm">
                  <div className="mb-1 text-xs font-medium text-muted-foreground">Copilot</div>
                  <div className="whitespace-pre-wrap">{t.answer}</div>
                  {t.sources.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {t.sources.map((s) => (
                        <Badge key={s.id} variant="outline" className="text-xs">
                          {s.name} ({s.rowsUsed}{s.truncated ? "+" : ""} rows)
                        </Badge>
                      ))}
                    </div>
                  )}
                </Card>
              </div>
            ))
          )}
          {askMut.isPending && (
            <Card className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Thinking…
            </Card>
          )}
        </div>

        <Card className="p-3">
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. Which activities are running late?  Or: total certified billing for Vendor X?"
            rows={3}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSend) {
                e.preventDefault();
                askMut.mutate();
              }
            }}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter to send</span>
            <Button onClick={() => askMut.mutate()} disabled={!canSend}>
              {askMut.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Ask
            </Button>
          </div>
        </Card>
      </section>
    </div>
  );
}

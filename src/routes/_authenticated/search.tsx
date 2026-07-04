import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { semanticSearch, type SearchHit, type SearchKind } from "@/lib/search.functions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Search,
  FileText,
  Sheet as SheetIcon,
  ListChecks,
  Loader2,
  ArrowUpRight,
  X,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/search")({
  component: SearchPage,
});

const KIND_LABELS: Record<SearchKind, string> = {
  document: "Documents",
  sheet: "Sheets",
  activity: "Activities",
};

function iconFor(kind: SearchHit["kind"]) {
  if (kind === "document") return <FileText className="h-4 w-4" />;
  if (kind === "sheet") return <SheetIcon className="h-4 w-4" />;
  return <ListChecks className="h-4 w-4" />;
}

function buildHighlightTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .filter((t) => t.length >= 2);
}

function Highlighted({ text, tokens }: { text: string; tokens: string[] }) {
  if (tokens.length === 0) return <>{text}</>;
  const splitRe = new RegExp(`(${tokens.join("|")})`, "gi");
  const testRe = new RegExp(`^(?:${tokens.join("|")})$`, "i");
  const parts = text.split(splitRe);
  return (
    <>
      {parts.map((part, i) =>
        testRe.test(part) ? (
          <mark
            key={i}
            className="rounded bg-yellow-200 px-0.5 text-foreground dark:bg-yellow-500/40"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function SearchPage() {
  const [q, setQ] = useState("");
  const [lastQuery, setLastQuery] = useState("");
  const [kinds, setKinds] = useState<Set<SearchKind>>(
    new Set<SearchKind>(["document", "sheet", "activity"]),
  );
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const search = useServerFn(semanticSearch);
  const mut = useMutation({
    mutationFn: async (input: {
      query: string;
      kinds: SearchKind[];
      dateFrom?: string;
      dateTo?: string;
    }) =>
      search({
        data: {
          query: input.query,
          kinds: input.kinds,
          dateFrom: input.dateFrom || undefined,
          dateTo: input.dateTo || undefined,
        },
      }),
  });

  const toggleKind = (k: SearchKind) => {
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) {
        if (next.size > 1) next.delete(k);
      } else {
        next.add(k);
      }
      return next;
    });
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = q.trim();
    if (!trimmed) return;
    setLastQuery(trimmed);
    mut.mutate({
      query: trimmed,
      kinds: Array.from(kinds),
      dateFrom,
      dateTo,
    });
  };

  const clearDates = () => {
    setDateFrom("");
    setDateTo("");
  };

  const hits = mut.data?.hits ?? [];
  const tokens = useMemo(() => buildHighlightTokens(lastQuery), [lastQuery]);
  const hasDateFilter = !!(dateFrom || dateTo);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Semantic search</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Ask a question across your documents, sheets, and activities. Ranked by AI relevance, with
          matched terms highlighted.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="e.g. delayed pump installations in Q3"
              className="pl-9"
            />
          </div>
          <Button type="submit" disabled={mut.isPending || !q.trim()}>
            {mut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}
          </Button>
        </div>

        <div className="flex flex-wrap items-end gap-4 rounded-md border bg-muted/30 p-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Include</span>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(KIND_LABELS) as SearchKind[]).map((k) => {
                const active = kinds.has(k);
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => toggleKind(k)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition ${
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-input bg-background text-muted-foreground hover:text-foreground"
                    }`}
                    aria-pressed={active}
                  >
                    {iconFor(k)}
                    {KIND_LABELS[k]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="date-from" className="text-xs font-medium text-muted-foreground">
              From
            </Label>
            <Input
              id="date-from"
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-8 w-40"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="date-to" className="text-xs font-medium text-muted-foreground">
              To
            </Label>
            <Input
              id="date-to"
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-8 w-40"
            />
          </div>
          {hasDateFilter && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearDates}
              className="h-8 gap-1 text-xs"
            >
              <X className="h-3 w-3" />
              Clear dates
            </Button>
          )}
        </div>
      </form>

      <div className="mt-6 space-y-3">
        {mut.isError && <p className="text-sm text-destructive">{(mut.error as Error).message}</p>}
        {mut.isSuccess && hits.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No results. Try a different phrasing or widen your filters.
          </p>
        )}
        {hits.map((h, i) => (
          <Card key={i} className="p-4 transition hover:border-primary/50">
            <div className="flex items-start justify-between gap-3">
              <Link
                to={h.href as never}
                className="group flex min-w-0 items-center gap-2 text-sm font-medium hover:underline"
              >
                {iconFor(h.kind)}
                <span className="truncate">
                  <Highlighted text={h.title} tokens={tokens} />
                </span>
                <ArrowUpRight className="h-3.5 w-3.5 shrink-0 opacity-0 transition group-hover:opacity-70" />
              </Link>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="secondary" className="capitalize">
                  {h.kind}
                </Badge>
                {h.meta && <span className="text-xs text-muted-foreground">{h.meta}</span>}
              </div>
            </div>
            {h.snippet && (
              <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
                <Highlighted text={h.snippet} tokens={tokens} />
              </p>
            )}
            <div className="mt-2 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                relevance {(h.similarity * 100).toFixed(0)}%
              </span>
              <Link to={h.href as never} className="text-xs text-primary hover:underline">
                Open {h.kind === "sheet" ? "row" : h.kind === "document" ? "document" : "activity"} →
              </Link>
            </div>
          </Card>
        ))}
      </div>
    </main>
  );
}

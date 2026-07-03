import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { semanticSearch, type SearchHit } from "@/lib/search.functions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Search, FileText, Sheet as SheetIcon, ListChecks, Loader2, ArrowUpRight } from "lucide-react";

export const Route = createFileRoute("/_authenticated/search")({
  component: SearchPage,
});

function iconFor(kind: SearchHit["kind"]) {
  if (kind === "document") return <FileText className="h-4 w-4" />;
  if (kind === "sheet") return <SheetIcon className="h-4 w-4" />;
  return <ListChecks className="h-4 w-4" />;
}

// Build a case-insensitive regex from the query tokens, escaping regex metacharacters.
function buildHighlightRegex(query: string): RegExp | null {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  return new RegExp(`(${tokens.join("|")})`, "gi");
}

function Highlighted({ text, regex }: { text: string; regex: RegExp | null }) {
  if (!regex) return <>{text}</>;
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className="rounded bg-yellow-200 px-0.5 text-foreground dark:bg-yellow-500/40">
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
  const search = useServerFn(semanticSearch);
  const mut = useMutation({
    mutationFn: async (query: string) => search({ data: { query } }),
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (q.trim()) mut.mutate(q.trim());
  };

  const hits = mut.data?.hits ?? [];

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Semantic search</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Ask a question across your documents, sheets, and activities. Ranked by AI relevance.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex gap-2">
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
      </form>

      <div className="mt-6 space-y-3">
        {mut.isError && (
          <p className="text-sm text-destructive">{(mut.error as Error).message}</p>
        )}
        {mut.isSuccess && hits.length === 0 && (
          <p className="text-sm text-muted-foreground">No results. Try a different phrasing.</p>
        )}
        {hits.map((h, i) => (
          <Card key={i} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <Link
                to={h.href as never}
                className="flex items-center gap-2 text-sm font-medium hover:underline"
              >
                {iconFor(h.kind)}
                <span>{h.title}</span>
              </Link>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="secondary" className="capitalize">{h.kind}</Badge>
                {h.meta && <span className="text-xs text-muted-foreground">{h.meta}</span>}
              </div>
            </div>
            {h.snippet && (
              <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{h.snippet}</p>
            )}
            <div className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
              relevance {(h.similarity * 100).toFixed(0)}%
            </div>
          </Card>
        ))}
      </div>
    </main>
  );
}

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import {
  semanticSearch,
  ACTIVITY_STATUSES,
  DOCUMENT_STATUSES,
  type SearchHit,
  type SearchKind,
  type SearchSort,
  type ActivityStatus,
  type DocumentStatus,
} from "@/lib/search.functions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Search,
  FileText,
  Sheet as SheetIcon,
  ListChecks,
  Loader2,
  ArrowUpRight,
  X,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";

const KIND_VALUES = ["document", "sheet", "activity"] as const;
const SORT_VALUES = ["relevance", "newest"] as const;
const PAGE_SIZES = [10, 25, 50] as const;

const searchSchema = z.object({
  q: fallback(z.string(), "").default(""),
  kinds: fallback(z.array(z.enum(KIND_VALUES)), []).default([]),
  from: fallback(z.string(), "").default(""),
  to: fallback(z.string(), "").default(""),
  sort: fallback(z.enum(SORT_VALUES), "relevance").default("relevance"),
  page: fallback(z.number().int().min(1), 1).default(1),
  pageSize: fallback(z.union([z.literal(10), z.literal(25), z.literal(50)]), 10).default(10),
  aStatus: fallback(z.array(z.enum(ACTIVITY_STATUSES)), []).default([]),
  dStatus: fallback(z.array(z.enum(DOCUMENT_STATUSES)), []).default([]),
});

export const Route = createFileRoute("/_authenticated/search")({
  validateSearch: zodValidator(searchSchema),
  component: SearchPage,
});

const KIND_LABELS: Record<SearchKind, string> = {
  document: "Documents",
  sheet: "Sheets",
  activity: "Activities",
};

const ACTIVITY_STATUS_LABELS: Record<ActivityStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  blocked: "Blocked",
  overdue: "Overdue",
};

const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  pending: "Pending",
  processing: "Processing",
  ready: "Ready",
  failed: "Failed",
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

function TogglePill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition ${
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-background text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function SearchPage() {
  const params = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  // Local input state so typing doesn't spam the URL/search on every keystroke.
  const [qInput, setQInput] = useState(params.q);
  useEffect(() => {
    setQInput(params.q);
  }, [params.q]);

  const search = useServerFn(semanticSearch);
  const mut = useMutation({
    mutationFn: async (p: typeof params) =>
      search({
        data: {
          query: p.q,
          kinds: p.kinds.length ? p.kinds : undefined,
          dateFrom: p.from || undefined,
          dateTo: p.to || undefined,
          sort: p.sort,
          page: p.page,
          pageSize: p.pageSize,
          activityStatuses: p.aStatus.length ? p.aStatus : undefined,
          documentStatuses: p.dStatus.length ? p.dStatus : undefined,
        },
      }),
  });

  // Re-run search whenever URL params change and there's a query.
  useEffect(() => {
    if (params.q.trim()) mut.mutate(params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    params.q,
    params.sort,
    params.page,
    params.pageSize,
    params.from,
    params.to,
    params.kinds.join(","),
    params.aStatus.join(","),
    params.dStatus.join(","),
  ]);

  const updateParams = (patch: Partial<typeof params>, resetPage = true) => {
    navigate({
      search: (prev: typeof params) => ({
        ...prev,
        ...patch,
        ...(resetPage ? { page: 1 } : {}),
      }),
      replace: true,
    });
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    updateParams({ q: qInput.trim() });
  };

  const toggleKind = (k: SearchKind) => {
    const cur = new Set(params.kinds);
    if (cur.has(k)) cur.delete(k);
    else cur.add(k);
    updateParams({ kinds: Array.from(cur) as SearchKind[] });
  };

  const toggleActivityStatus = (s: ActivityStatus) => {
    const cur = new Set(params.aStatus);
    if (cur.has(s)) cur.delete(s);
    else cur.add(s);
    updateParams({ aStatus: Array.from(cur) as ActivityStatus[] });
  };

  const toggleDocStatus = (s: DocumentStatus) => {
    const cur = new Set(params.dStatus);
    if (cur.has(s)) cur.delete(s);
    else cur.add(s);
    updateParams({ dStatus: Array.from(cur) as DocumentStatus[] });
  };

  const clearAll = () => {
    setQInput("");
    navigate({
      search: {
        q: "",
        kinds: [],
        from: "",
        to: "",
        sort: "relevance",
        page: 1,
        pageSize: 10,
        aStatus: [],
        dStatus: [],
      },
      replace: true,
    });
  };

  const hits = mut.data?.hits ?? [];
  const hasMore = mut.data?.hasMore ?? false;
  const totalCandidates = mut.data?.totalCandidates ?? 0;
  const tokens = useMemo(() => buildHighlightTokens(params.q), [params.q]);

  const showKind = (k: SearchKind) => params.kinds.length === 0 || params.kinds.includes(k);
  const activeKinds = params.kinds.length ? params.kinds : (KIND_VALUES as readonly SearchKind[]);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 md:px-6">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Semantic search</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Ask a question across your documents, sheets, and activities. Filters and sort are
            shareable via the URL.
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={clearAll} className="gap-1">
          <X className="h-3.5 w-3.5" /> Reset
        </Button>
      </div>

      <form onSubmit={onSubmit} className="space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="e.g. delayed pump installations in Q3"
              className="pl-9"
            />
          </div>
          <Button type="submit" disabled={mut.isPending || !qInput.trim()}>
            {mut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}
          </Button>
        </div>

        <div className="space-y-3 rounded-md border bg-muted/30 p-3">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Include</span>
              <div className="flex flex-wrap gap-1.5">
                {(KIND_VALUES as readonly SearchKind[]).map((k) => (
                  <TogglePill
                    key={k}
                    active={params.kinds.length === 0 ? true : params.kinds.includes(k)}
                    onClick={() => toggleKind(k)}
                  >
                    {iconFor(k)}
                    {KIND_LABELS[k]}
                  </TogglePill>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="date-from" className="text-xs font-medium text-muted-foreground">
                From
              </Label>
              <Input
                id="date-from"
                type="date"
                value={params.from}
                max={params.to || undefined}
                onChange={(e) => updateParams({ from: e.target.value })}
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
                value={params.to}
                min={params.from || undefined}
                onChange={(e) => updateParams({ to: e.target.value })}
                className="h-8 w-40"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Sort</Label>
              <Select
                value={params.sort}
                onValueChange={(v) => updateParams({ sort: v as SearchSort })}
              >
                <SelectTrigger className="h-8 w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="relevance">Relevance</SelectItem>
                  <SelectItem value="newest">Newest first</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Page size</Label>
              <Select
                value={String(params.pageSize)}
                onValueChange={(v) =>
                  updateParams({ pageSize: Number(v) as (typeof PAGE_SIZES)[number] })
                }
              >
                <SelectTrigger className="h-8 w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZES.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {showKind("activity") && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Activity status</span>
              <div className="flex flex-wrap gap-1.5">
                {ACTIVITY_STATUSES.map((s) => (
                  <TogglePill
                    key={s}
                    active={params.aStatus.includes(s)}
                    onClick={() => toggleActivityStatus(s)}
                  >
                    {ACTIVITY_STATUS_LABELS[s]}
                  </TogglePill>
                ))}
              </div>
            </div>
          )}

          {showKind("document") && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Document status</span>
              <div className="flex flex-wrap gap-1.5">
                {DOCUMENT_STATUSES.map((s) => (
                  <TogglePill
                    key={s}
                    active={params.dStatus.includes(s)}
                    onClick={() => toggleDocStatus(s)}
                  >
                    {DOCUMENT_STATUS_LABELS[s]}
                  </TogglePill>
                ))}
              </div>
            </div>
          )}
        </div>
      </form>

      <div className="mt-6 space-y-3">
        {mut.isError && <p className="text-sm text-destructive">{(mut.error as Error).message}</p>}
        {mut.isSuccess && hits.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No results on this page. Try a different phrasing or widen your filters.
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
                {params.sort === "newest" && h.createdAt
                  ? new Date(h.createdAt).toLocaleDateString()
                  : `relevance ${(h.similarity * 100).toFixed(0)}%`}
              </span>
              <Link to={h.href as never} className="text-xs text-primary hover:underline">
                Open {h.kind === "sheet" ? "row" : h.kind === "document" ? "document" : "activity"}{" "}
                →
              </Link>
            </div>
          </Card>
        ))}

        {(hits.length > 0 || params.page > 1) && (
          <div className="flex items-center justify-between border-t pt-4 text-sm">
            <span className="text-xs text-muted-foreground">
              Page {params.page} · showing {hits.length} of {totalCandidates}
              {hasMore ? "+" : ""}{" "}
              <span className="ml-1">
                across {activeKinds.map((k) => KIND_LABELS[k].toLowerCase()).join(", ")}
              </span>
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={params.page <= 1 || mut.isPending}
                onClick={() => updateParams({ page: Math.max(1, params.page - 1) }, false)}
              >
                <ChevronLeft className="h-4 w-4" /> Prev
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!hasMore || mut.isPending}
                onClick={() => updateParams({ page: params.page + 1 }, false)}
              >
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

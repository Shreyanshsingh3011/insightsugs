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
  Sparkles,
  SlidersHorizontal,
  Calendar as CalendarIcon,
  ArrowUpDown,
  Command,
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

// ---------- Design tokens (Slate & Steel / Space Grotesk + DM Sans) ----------
const FONT_STACK = {
  display: `"Space Grotesk", ui-sans-serif, system-ui, sans-serif`,
  body: `"DM Sans", ui-sans-serif, system-ui, sans-serif`,
};

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

function iconFor(kind: SearchKind) {
  if (kind === "document") return <FileText className="h-3.5 w-3.5" />;
  if (kind === "sheet") return <SheetIcon className="h-3.5 w-3.5" />;
  return <ListChecks className="h-3.5 w-3.5" />;
}

function kindAccent(kind: SearchKind) {
  // subtle color chip per kind, muted to fit the slate palette
  if (kind === "document") return "bg-sky-500/15 text-sky-300 ring-sky-400/20";
  if (kind === "sheet") return "bg-emerald-500/15 text-emerald-300 ring-emerald-400/20";
  return "bg-amber-500/15 text-amber-300 ring-amber-400/20";
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
            className="rounded-sm bg-slate-100/80 px-0.5 text-slate-900 dark:bg-slate-300/25 dark:text-slate-100"
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

function Chip({
  active,
  onClick,
  children,
  tone = "slate",
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  tone?: "slate" | "muted";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`group inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium tracking-wide transition-all duration-200 ${
        active
          ? "border-slate-300/70 bg-slate-100 text-slate-900 shadow-sm dark:border-slate-400/40 dark:bg-slate-100/10 dark:text-slate-50"
          : tone === "muted"
            ? "border-slate-200/70 bg-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:border-slate-700/60 dark:text-slate-400 dark:hover:border-slate-500 dark:hover:text-slate-100"
            : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900 dark:border-slate-700/70 dark:bg-slate-800/40 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-50"
      }`}
    >
      {children}
    </button>
  );
}

function SectionLabel({
  icon,
  children,
  onClear,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClear?: () => void;
}) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <div
        className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400"
        style={{ fontFamily: FONT_STACK.display }}
      >
        {icon}
        {children}
      </div>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="text-[10px] uppercase tracking-wider text-slate-400 transition-colors hover:text-slate-700 dark:hover:text-slate-200"
        >
          clear
        </button>
      )}
    </div>
  );
}

function SearchPage() {
  const params = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

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
  const activeFilterCount =
    (params.kinds.length > 0 ? 1 : 0) +
    (params.from ? 1 : 0) +
    (params.to ? 1 : 0) +
    (params.aStatus.length > 0 ? 1 : 0) +
    (params.dStatus.length > 0 ? 1 : 0);

  return (
    <div
      className="min-h-full bg-gradient-to-b from-slate-50 to-white text-slate-800 dark:from-slate-950 dark:to-slate-900 dark:text-slate-200"
      style={{ fontFamily: FONT_STACK.body }}
    >
      {/* Top command bar */}
      <div className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/70 backdrop-blur-xl dark:border-slate-800/70 dark:bg-slate-950/60">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4 md:px-8">
          <div className="hidden items-center gap-2 md:flex">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-800 text-slate-100 dark:bg-slate-100 dark:text-slate-900"
              aria-hidden
            >
              <Sparkles className="h-4 w-4" />
            </div>
            <div className="leading-tight">
              <div
                className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-50"
                style={{ fontFamily: FONT_STACK.display }}
              >
                Ask anything
              </div>
              <div className="text-[10px] uppercase tracking-[0.16em] text-slate-400">
                semantic · ranked
              </div>
            </div>
          </div>

          <form onSubmit={onSubmit} className="relative flex-1">
            <div className="group relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition-all duration-300 focus-within:border-slate-400 focus-within:shadow-lg focus-within:shadow-slate-900/5 dark:border-slate-700/70 dark:bg-slate-900/60 dark:focus-within:border-slate-400 dark:focus-within:shadow-slate-950/40">
              <div className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-focus-within:opacity-100">
                <div className="absolute inset-x-6 -top-px h-px bg-gradient-to-r from-transparent via-slate-400/70 to-transparent" />
              </div>
              <div className="flex items-center gap-2 pl-4 pr-2">
                <Search
                  className={`h-4 w-4 shrink-0 transition-colors ${
                    mut.isPending
                      ? "text-slate-400"
                      : "text-slate-500 dark:text-slate-400"
                  }`}
                />
                <input
                  autoFocus
                  value={qInput}
                  onChange={(e) => setQInput(e.target.value)}
                  placeholder="Ask across documents, sheets and activities…"
                  className="h-12 w-full bg-transparent text-[15px] tracking-tight text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-50"
                  style={{ fontFamily: FONT_STACK.body }}
                />
                {qInput && (
                  <button
                    type="button"
                    onClick={() => setQInput("")}
                    className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                    aria-label="Clear query"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
                <span className="hidden items-center gap-1 rounded-md border border-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:border-slate-700 dark:text-slate-400 md:inline-flex">
                  <Command className="h-3 w-3" />K
                </span>
                <Button
                  type="submit"
                  disabled={mut.isPending || !qInput.trim()}
                  className="ml-1 h-9 gap-1.5 rounded-xl bg-slate-900 px-4 text-sm font-medium text-slate-50 shadow-sm transition-all hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
                >
                  {mut.isPending ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Thinking
                    </>
                  ) : (
                    <>
                      Search
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    </>
                  )}
                </Button>
              </div>
            </div>
          </form>

          <button
            type="button"
            onClick={clearAll}
            className="hidden items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-medium text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-800 dark:border-slate-700 dark:text-slate-400 dark:hover:border-slate-500 dark:hover:text-slate-100 lg:inline-flex"
          >
            <X className="h-3 w-3" /> Reset
          </button>
        </div>
      </div>

      {/* Main split layout */}
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-4 py-6 md:px-8 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* Sidebar filters */}
        <aside className="lg:sticky lg:top-24 lg:h-fit">
          <div className="rounded-2xl border border-slate-200 bg-white/80 p-5 shadow-sm backdrop-blur dark:border-slate-800/70 dark:bg-slate-900/50">
            <div className="mb-4 flex items-center justify-between">
              <div
                className="flex items-center gap-2 text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-50"
                style={{ fontFamily: FONT_STACK.display }}
              >
                <SlidersHorizontal className="h-4 w-4" />
                Filters
              </div>
              {activeFilterCount > 0 && (
                <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[10px] font-medium text-slate-50 dark:bg-slate-100 dark:text-slate-900">
                  {activeFilterCount} active
                </span>
              )}
            </div>

            <SectionLabel
              icon={<ListChecks className="h-3 w-3" />}
              onClear={params.kinds.length ? () => updateParams({ kinds: [] }) : undefined}
            >
              Sources
            </SectionLabel>
            <div className="mb-5 flex flex-wrap gap-1.5">
              {(KIND_VALUES as readonly SearchKind[]).map((k) => (
                <Chip
                  key={k}
                  active={params.kinds.length === 0 ? true : params.kinds.includes(k)}
                  onClick={() => toggleKind(k)}
                >
                  {iconFor(k)}
                  {KIND_LABELS[k]}
                </Chip>
              ))}
            </div>

            <SectionLabel icon={<ArrowUpDown className="h-3 w-3" />}>Sort & size</SectionLabel>
            <div className="mb-5 grid grid-cols-2 gap-2">
              <Select
                value={params.sort}
                onValueChange={(v) => updateParams({ sort: v as SearchSort })}
              >
                <SelectTrigger className="h-8 rounded-lg border-slate-200 bg-white text-xs dark:border-slate-700 dark:bg-slate-900/60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="relevance">Relevance</SelectItem>
                  <SelectItem value="newest">Newest first</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={String(params.pageSize)}
                onValueChange={(v) =>
                  updateParams({ pageSize: Number(v) as (typeof PAGE_SIZES)[number] })
                }
              >
                <SelectTrigger className="h-8 rounded-lg border-slate-200 bg-white text-xs dark:border-slate-700 dark:bg-slate-900/60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZES.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} / page
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <SectionLabel
              icon={<CalendarIcon className="h-3 w-3" />}
              onClear={
                params.from || params.to
                  ? () => updateParams({ from: "", to: "" })
                  : undefined
              }
            >
              Date range
            </SectionLabel>
            <div className="mb-5 grid grid-cols-2 gap-2">
              <Input
                type="date"
                value={params.from}
                max={params.to || undefined}
                onChange={(e) => updateParams({ from: e.target.value })}
                className="h-8 rounded-lg border-slate-200 bg-white text-xs dark:border-slate-700 dark:bg-slate-900/60"
              />
              <Input
                type="date"
                value={params.to}
                min={params.from || undefined}
                onChange={(e) => updateParams({ to: e.target.value })}
                className="h-8 rounded-lg border-slate-200 bg-white text-xs dark:border-slate-700 dark:bg-slate-900/60"
              />
            </div>

            {showKind("activity") && (
              <>
                <SectionLabel
                  icon={<ListChecks className="h-3 w-3" />}
                  onClear={params.aStatus.length ? () => updateParams({ aStatus: [] }) : undefined}
                >
                  Activity status
                </SectionLabel>
                <div className="mb-5 flex flex-wrap gap-1.5">
                  {ACTIVITY_STATUSES.map((s) => (
                    <Chip
                      key={s}
                      active={params.aStatus.includes(s)}
                      onClick={() => toggleActivityStatus(s)}
                      tone="muted"
                    >
                      {ACTIVITY_STATUS_LABELS[s]}
                    </Chip>
                  ))}
                </div>
              </>
            )}

            {showKind("document") && (
              <>
                <SectionLabel
                  icon={<FileText className="h-3 w-3" />}
                  onClear={params.dStatus.length ? () => updateParams({ dStatus: [] }) : undefined}
                >
                  Document status
                </SectionLabel>
                <div className="flex flex-wrap gap-1.5">
                  {DOCUMENT_STATUSES.map((s) => (
                    <Chip
                      key={s}
                      active={params.dStatus.includes(s)}
                      onClick={() => toggleDocStatus(s)}
                      tone="muted"
                    >
                      {DOCUMENT_STATUS_LABELS[s]}
                    </Chip>
                  ))}
                </div>
              </>
            )}
          </div>
        </aside>

        {/* Results */}
        <section>
          <ResultsMeta
            isPending={mut.isPending}
            hasQuery={!!params.q.trim()}
            total={totalCandidates}
            hasMore={hasMore}
            page={params.page}
            pageSize={params.pageSize}
            hitsCount={hits.length}
            sort={params.sort}
          />

          {!params.q.trim() && !mut.isPending && <EmptyState onExample={(ex) => {
            setQInput(ex);
            updateParams({ q: ex });
          }} />}

          {mut.isError && (
            <p className="mt-4 text-sm text-red-500">{(mut.error as Error).message}</p>
          )}

          {mut.isPending && (
            <div className="mt-4 space-y-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="animate-pulse rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800/70 dark:bg-slate-900/40"
                >
                  <div className="mb-3 h-4 w-1/2 rounded bg-slate-200 dark:bg-slate-700/60" />
                  <div className="h-3 w-full rounded bg-slate-100 dark:bg-slate-800/60" />
                  <div className="mt-1.5 h-3 w-4/5 rounded bg-slate-100 dark:bg-slate-800/60" />
                </div>
              ))}
            </div>
          )}

          {!mut.isPending && mut.isSuccess && hits.length === 0 && params.q.trim() && (
            <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-white/60 p-10 text-center dark:border-slate-700/70 dark:bg-slate-900/40">
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <Search className="h-4 w-4" />
              </div>
              <p
                className="text-sm font-medium text-slate-700 dark:text-slate-200"
                style={{ fontFamily: FONT_STACK.display }}
              >
                No matches on this page
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Try a different phrasing or loosen your filters.
              </p>
            </div>
          )}

          <ul className="mt-4 space-y-2.5">
            {hits.map((h, i) => (
              <li
                key={i}
                className="animate-in fade-in slide-in-from-bottom-1 duration-300"
                style={{ animationDelay: `${i * 30}ms`, animationFillMode: "backwards" }}
              >
                <ResultCard hit={h} tokens={tokens} sort={params.sort} />
              </li>
            ))}
          </ul>

          {(hits.length > 0 || params.page > 1) && !mut.isPending && (
            <div className="mt-6 flex items-center justify-between border-t border-slate-200 pt-4 dark:border-slate-800/70">
              <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
                page {params.page} · {hits.length} of {totalCandidates}
                {hasMore ? "+" : ""}
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={params.page <= 1}
                  onClick={() => updateParams({ page: Math.max(1, params.page - 1) }, false)}
                  className="h-8 gap-1 rounded-lg border-slate-200 text-xs text-slate-700 dark:border-slate-700 dark:text-slate-200"
                >
                  <ChevronLeft className="h-3.5 w-3.5" /> Prev
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!hasMore}
                  onClick={() => updateParams({ page: params.page + 1 }, false)}
                  className="h-8 gap-1 rounded-lg border-slate-200 text-xs text-slate-700 dark:border-slate-700 dark:text-slate-200"
                >
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ResultsMeta({
  isPending,
  hasQuery,
  total,
  hasMore,
  page,
  pageSize,
  hitsCount,
  sort,
}: {
  isPending: boolean;
  hasQuery: boolean;
  total: number;
  hasMore: boolean;
  page: number;
  pageSize: number;
  hitsCount: number;
  sort: SearchSort;
}) {
  return (
    <div className="mb-1 flex items-center justify-between">
      <h1
        className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50"
        style={{ fontFamily: FONT_STACK.display }}
      >
        {isPending ? "Searching…" : hasQuery ? "Results" : "Start with a question"}
      </h1>
      {hasQuery && !isPending && (
        <div className="text-[11px] uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
          {total}
          {hasMore ? "+" : ""} matches · sorted by {sort}
        </div>
      )}
      {!hasQuery && (
        <div className="text-[11px] uppercase tracking-[0.14em] text-slate-400">
          {pageSize}/page · page {page} · {hitsCount} shown
        </div>
      )}
    </div>
  );
}

function EmptyState({ onExample }: { onExample: (q: string) => void }) {
  const examples = [
    "delayed pump installations in Q3",
    "overdue site inspections",
    "sheets mentioning cement shortage",
    "documents about MEP scope changes",
  ];
  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-8 dark:border-slate-800/70 dark:from-slate-900/60 dark:to-slate-950/40">
      <div className="mx-auto max-w-lg text-center">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-slate-100 shadow-lg shadow-slate-900/20 dark:bg-slate-100 dark:text-slate-900">
          <Sparkles className="h-5 w-5" />
        </div>
        <h2
          className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50"
          style={{ fontFamily: FONT_STACK.display }}
        >
          Ask across your whole workspace
        </h2>
        <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
          Semantic search over documents, sheets and activities. Ranked by AI, with highlighted
          snippets and deep links.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-1.5">
          {examples.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => onExample(ex)}
              className="group inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:text-slate-900 hover:shadow-sm dark:border-slate-700/70 dark:bg-slate-900/60 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-50"
            >
              <Sparkles className="h-3 w-3 opacity-60 transition-opacity group-hover:opacity-100" />
              {ex}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ResultCard({
  hit,
  tokens,
  sort,
}: {
  hit: SearchHit;
  tokens: string[];
  sort: SearchSort;
}) {
  return (
    <Link
      to={hit.href as never}
      className="group block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md hover:shadow-slate-900/5 dark:border-slate-800/70 dark:bg-slate-900/50 dark:hover:border-slate-500 dark:hover:shadow-slate-950/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset ${kindAccent(
              hit.kind,
            )}`}
          >
            {iconFor(hit.kind)}
            {hit.kind}
          </span>
          <h3
            className="truncate text-sm font-semibold tracking-tight text-slate-900 group-hover:underline dark:text-slate-50"
            style={{ fontFamily: FONT_STACK.display }}
          >
            <Highlighted text={hit.title} tokens={tokens} />
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-slate-400">
          {hit.meta && <span>{hit.meta}</span>}
          <ArrowUpRight className="h-3.5 w-3.5 text-slate-400 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-slate-700 dark:group-hover:text-slate-200" />
        </div>
      </div>

      {hit.snippet && (
        <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-slate-600 dark:text-slate-300">
          <Highlighted text={hit.snippet} tokens={tokens} />
        </p>
      )}

      <div className="mt-3 flex items-center justify-between">
        {sort === "newest" && hit.createdAt ? (
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-slate-400">
            <CalendarIcon className="h-3 w-3" />
            {new Date(hit.createdAt).toLocaleDateString()}
          </div>
        ) : (
          <RelevanceBar value={hit.similarity} />
        )}
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400 transition-colors group-hover:text-slate-700 dark:group-hover:text-slate-200">
          open →
        </span>
      </div>
    </Link>
  );
}

function RelevanceBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-24 overflow-hidden rounded-full bg-slate-200/70 dark:bg-slate-700/60">
        <div
          className="h-full rounded-full bg-gradient-to-r from-slate-500 to-slate-800 transition-all duration-500 dark:from-slate-300 dark:to-slate-100"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] font-medium tabular-nums uppercase tracking-[0.14em] text-slate-400">
        {pct.toFixed(0)}%
      </span>
    </div>
  );
}

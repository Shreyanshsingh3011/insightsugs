import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { listSheets } from "@/lib/sheets.functions";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Small "View source" chip that jumps to the exact row inside the internal
 * sheet detail page (`/sheets/$sheetId`) when a registered sheet matches
 * `projectLabel`. Falls back to opening the external `fallbackUrl` in a new
 * tab when no internal sheet is registered.
 *
 * Matching logic:
 * - Sheet: display_name equals or contains the project label.
 * - Row:   sheet detail scans loaded rows for a cell containing `activity`
 *          (optionally scoped to `matchCol`).
 */
export function ViewSourceLink({
  projectId,
  projectLabel,
  sourceUrl,
  activity,
  matchCol,
  fallbackUrl,
  className,
  compact,
}: {
  projectId?: string | null;
  projectLabel?: string | null;
  sourceUrl?: string | null;
  activity?: string | null;
  matchCol?: string | null;
  fallbackUrl?: string | null;
  className?: string;
  compact?: boolean;
}) {
  const fetchList = useServerFn(listSheets);
  const q = useQuery({
    queryKey: ["view-source-sheets"],
    queryFn: () => fetchList(),
    staleTime: 5 * 60 * 1000,
  });

  const list = (q.data?.sheets ?? []) as {
    id: string;
    display_name: string;
    source_url?: string | null;
  }[];
  const label = projectLabel ? norm(projectLabel) : "";
  const pid = projectId ? norm(projectId) : "";
  const srcNorm = sourceUrl ? sourceUrl.trim().toLowerCase() : "";
  const fbNorm = fallbackUrl ? fallbackUrl.trim().toLowerCase() : "";

  // Deterministic resolution order — first hit wins so the chip always lands
  // on the same sheet for the same project:
  //   1. Exact source_url match (project identity).
  //   2. source_url contains / is contained by the project's URL (proxy vs
  //      canonical Google Sheets URL variance).
  //   3. display_name exactly equals the project label OR the project id slug.
  //   4. display_name fuzzy contains / is contained by the label.
  const eqUrl = (a: string, b: string) => !!a && !!b && (a === b || a.includes(b) || b.includes(a));
  const sheet =
    list.find((s) => (s.source_url ?? "").trim().toLowerCase() === srcNorm && srcNorm) ??
    list.find((s) => eqUrl((s.source_url ?? "").trim().toLowerCase(), srcNorm)) ??
    list.find((s) => eqUrl((s.source_url ?? "").trim().toLowerCase(), fbNorm)) ??
    list.find((s) => {
      const n = norm(s.display_name);
      return (label && n === label) || (pid && n === pid);
    }) ??
    list.find((s) => {
      const n = norm(s.display_name);
      return label && (n.includes(label) || label.includes(n));
    });

  const base =
    "inline-flex items-center gap-1 rounded-md border border-primary/25 bg-primary/5 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10";
  const cls = className ?? base + (compact ? "" : " mt-1");


  if (sheet) {
    const search: Record<string, unknown> = {};
    if (activity && activity.trim()) search.match = activity.trim();
    if (matchCol && matchCol.trim()) search.matchCol = matchCol.trim();
    return (
      <Link
        to="/sheets/$sheetId"
        params={{ sheetId: sheet.id }}
        search={search}
        onClick={(e) => e.stopPropagation()}
        className={cls}
        title={`Open ${sheet.display_name}${activity ? ` — ${activity}` : ""}`}
      >
        <ExternalLink className="h-3 w-3" />
        View source
      </Link>
    );
  }

  // Only fall back to an external URL when it's a human-viewable page
  // (e.g. Google Sheets). Never link to raw JSON API endpoints like
  // sheet2api / gviz — those render a wall of JSON with no context.
  const isViewable = /docs\.google\.com\/spreadsheets|\/edit(\?|#|$)/i.test(fallbackUrl ?? "");
  if (fallbackUrl && isViewable) {
    return (
      <a
        href={fallbackUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className={cls}
        title={`Open source (external)${projectLabel ? ` — ${projectLabel}` : ""}`}
      >
        <ExternalLink className="h-3 w-3" />
        View source
      </a>
    );
  }

  return null;
}


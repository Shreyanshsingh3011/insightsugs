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
  projectLabel,
  activity,
  matchCol,
  fallbackUrl,
  className,
  compact,
}: {
  projectLabel?: string | null;
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

  const label = projectLabel ? norm(projectLabel) : "";
  const sheet = (q.data?.sheets ?? []).find((s: { display_name: string }) => {
    if (!label) return false;
    const n = norm(s.display_name);
    return n === label || n.includes(label) || label.includes(n);
  }) as { id: string; display_name: string; source_url?: string | null } | undefined;

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

  if (fallbackUrl) {
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

import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";

type Source = { id: string; name: string; type: string };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Extract the first citation marker in an answer and turn it into a single
 * clickable "Open in dashboard" button that jumps to the exact row / cell
 * inside the sheet detail page.
 *
 * Supported marker shapes:
 *   [sheet:<name> row <n> col <ColumnName>]
 *   [sheet:<name> row <n>]           (also 1-14 / 3, 9 — first row is used)
 *   [sheet:<name>]
 */
export function PrimarySourceLink({
  answer,
  sources,
}: {
  answer: string;
  sources: Source[];
}) {
  const re = /\[([^\]\n]{2,}?)\](?!\()/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    const body = m[1].trim();
    if (!/^sheet:/i.test(body)) continue;

    const sheetRowCol = /^sheet:\s*(.+?)\s+row\s+(\d+)\s+col\s+(.+?)\s*$/i.exec(body);
    const sheetRow = !sheetRowCol
      ? /^sheet:\s*(.+?)\s+row\s+([\d\s,-]+?)\s*$/i.exec(body)
      : null;
    const sheetOnly =
      !sheetRowCol && !sheetRow ? /^sheet:\s*(.+?)\s*$/i.exec(body) : null;

    const label = (sheetRowCol?.[1] ?? sheetRow?.[1] ?? sheetOnly?.[1] ?? "").trim();
    const src = sources.find(
      (s) => s.type !== "document" && norm(s.name) === norm(label),
    );
    if (!src) continue;

    const rowSpec = sheetRowCol?.[2] ?? sheetRow?.[2];
    const rowN = rowSpec ? Number(rowSpec.match(/\d+/)?.[0] ?? NaN) : NaN;
    const col = sheetRowCol?.[3]?.trim();

    const search: Record<string, unknown> = {};
    if (Number.isFinite(rowN)) search.highlight = rowN - 1;
    if (col) search.col = col;

    const detail = col
      ? `row ${rowN} · col ${col}`
      : Number.isFinite(rowN)
      ? `row ${rowN}`
      : "sheet";

    return (
      <Link
        to="/sheets/$sheetId"
        params={{ sheetId: src.id }}
        search={search}
        className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/20"
        title={`Open ${src.name} — ${detail}`}
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Open source: {src.name} <span className="opacity-70">· {detail}</span>
      </Link>
    );
  }
  return null;
}

/** Remove inline [..] citation markers and the trailing `Sources:` block. */
export function stripCitations(answer: string): string {
  let out = answer.replace(/\n?\s*Sources\s*:\s*[\s\S]*$/i, "").trim();
  // Strip inline [sheet:...] / [doc:...] markers, keep other bracketed text
  // (e.g. markdown links [x](y) or [flag[F-1]]).
  out = out.replace(/\s?\[(?:sheet|doc):[^\]\n]+?\](?!\()/gi, "");
  // Collapse leftover double spaces before punctuation.
  return out.replace(/[ \t]+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
}

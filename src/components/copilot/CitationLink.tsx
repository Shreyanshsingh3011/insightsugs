import { Link } from "@tanstack/react-router";

type Source = { id: string; name: string; type: string };

type Props = {
  marker: string; // full "[sheet:X row 12]" or "[doc:foo p.4]"
  sources: Source[];
};

/**
 * Renders an inline citation marker as a clickable link.
 * - [sheet:<name> row <n>]  →  /sheets/<id>?highlight=<row-1>
 * - [sheet:<name> row 1-14] / [sheet:<name> row 3, 9] → first referenced row
 * - [sheet:<name>]          →  /sheets/<id>
 * - [doc:<name> p.<n>]      →  no viewer wired yet, renders as a badge with tooltip.
 * Unknown shapes fall back to plain text.
 */
export function CitationLink({ marker, sources }: Props) {
  const body = marker.slice(1, -1); // strip [ ]

  const sheetMatch = /^sheet:\s*(.+?)(?:\s+row\s+([\d\s,-]+))?\s*$/i.exec(body);
  if (sheetMatch) {
    const label = sheetMatch[1].trim();
    const rowSpec = sheetMatch[2]?.trim();
    const rowN = rowSpec ? Number(rowSpec.match(/\d+/)?.[0] ?? NaN) : null;
    const src = sources.find(
      (s) => s.type !== "document" && s.name.toLowerCase().replace(/\s+/g, " ").trim() === label.toLowerCase().replace(/\s+/g, " ").trim(),
    );
    if (src) {
      return (
        <Link
          to="/sheets/$sheetId"
          params={{ sheetId: src.id }}
          search={rowN ? { highlight: rowN - 1 } : {}}
          className="rounded bg-primary/10 px-1 py-0.5 text-[0.72rem] font-mono text-primary underline decoration-dotted underline-offset-2 hover:bg-primary/20"
          title={rowN ? `Open ${label} at row ${rowN}` : `Open ${label}`}
        >
          {marker}
        </Link>
      );
    }
  }

  const docMatch = /^doc:\s*(.+?)\s+p\.\s*(\d+)\s*$/i.exec(body);
  if (docMatch) {
    return (
      <span
        className="rounded bg-emerald-500/10 px-1 py-0.5 text-[0.72rem] font-mono text-emerald-700 dark:text-emerald-300"
        title={docMatch[0]}
      >
        {marker}
      </span>
    );
  }

  return (
    <span className="rounded bg-muted px-1 py-0.5 text-[0.72rem] font-mono text-muted-foreground">
      {marker}
    </span>
  );
}

/** Split an answer string into text + citation-link tokens for inline rendering. */
export function renderWithCitations(text: string, sources: Source[]): React.ReactNode[] {
  const re = /\[([^\]\n]{2,}?)\](?!\()/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<CitationLink key={`c-${key++}`} marker={m[0]} sources={sources} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

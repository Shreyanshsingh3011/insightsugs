// Shared CSV/PDF export for entity detail pages (person/stage/project/kpi/row).
// Stamps every export with scope + applied filter + generation time/timezone,
// and a data-window derived from the payload generated_at timestamps.

import type { ScopedRow } from "@/lib/entity-scope";

export type DetailExportContext = {
  kind: "person" | "stage" | "project" | "kpi" | "row";
  title: string;
  subtitle?: string;
  /** Optional filter description ("search=xyz", "min-delay≥7d"…). */
  appliedFilter?: string;
  /** Payload generated_at timestamps (ISO strings) from the live sources. */
  windowTimestamps?: Array<string | null | undefined>;
};

function dataWindow(stamps: Array<string | null | undefined> = []) {
  const nums = stamps
    .filter((v): v is string => !!v)
    .map((v) => new Date(v).getTime())
    .filter((n) => Number.isFinite(n));
  if (!nums.length) return { from: null as string | null, to: null as string | null };
  return {
    from: new Date(Math.min(...nums)).toISOString(),
    to: new Date(Math.max(...nums)).toISOString(),
  };
}

function safeName(s: string) {
  return (s || "detail").replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 60);
}

function summarize(rows: ScopedRow[]) {
  let done = 0, delayed = 0, sumDelay = 0;
  for (const r of rows) {
    if (/complete|done/i.test(r.status)) done++;
    if (r.delay > 0 && !/complete|done/i.test(r.status)) { delayed++; sumDelay += r.delay; }
  }
  const n = rows.length;
  return {
    n, done, delayed,
    avgDelay: delayed ? Math.round(sumDelay / delayed) : 0,
    completionPct: n ? Math.round((done / n) * 100) : 0,
    onTimePct: n ? Math.max(0, 100 - Math.round((delayed / n) * 100)) : 100,
  };
}

export function exportDetailCSV(rows: ScopedRow[], totalInScope: number, ctx: DetailExportContext) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const win = dataWindow(ctx.windowTimestamps);
  const s = summarize(rows);
  const lines = [
    "# Detail export",
    `# Scope,${ctx.kind}: ${ctx.title}${ctx.subtitle ? ` (${ctx.subtitle})` : ""}`,
    `# Applied filter,${ctx.appliedFilter?.trim() || "none"}`,
    `# Generated at,${new Date().toISOString()}`,
    `# Timezone,${tz}`,
    `# Data window from,${win.from ?? "n/a"}`,
    `# Data window to,${win.to ?? "n/a"}`,
    `# Rows exported,${rows.length}`,
    `# Rows in scope (unfiltered),${totalInScope}`,
    "",
    "KPI,Value",
    `Activities,${s.n}`,
    `Completion %,${s.completionPct}`,
    `On-time %,${s.onTimePct}`,
    `Delayed,${s.delayed}`,
    `Avg delay (days),${s.avgDelay}`,
    "",
    "Project,Activity,Person,Email,Stage,Status,TAT,Days Taken,Delay Days",
  ];
  const esc = (v: unknown) => {
    const str = v == null ? "" : String(v);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  for (const r of rows) {
    lines.push([r.project, r.activity, r.person, r.email, r.stage, r.status, r.tat, r.taken, r.delay].map(esc).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${ctx.kind}-${safeName(ctx.title)}-${rows.length}of${totalInScope}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export async function exportDetailPDF(rows: ScopedRow[], totalInScope: number, ctx: DetailExportContext) {
  const { default: JsPDF } = await import("jspdf");
  const doc = new JsPDF({ unit: "pt", format: "a4" });
  const margin = 40;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const win = dataWindow(ctx.windowTimestamps);
  const s = summarize(rows);
  let y = margin;

  doc.setFont("helvetica", "bold"); doc.setFontSize(16);
  doc.text(`${ctx.kind.toUpperCase()} · ${ctx.title}`, margin, y); y += 20;

  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(90);
  for (const line of [
    ctx.subtitle ?? "",
    `Applied filter: ${ctx.appliedFilter?.trim() || "none"}`,
    `Generated: ${new Date().toLocaleString()} (${tz})`,
    `Data window: ${win.from ? new Date(win.from).toLocaleString() : "n/a"} → ${win.to ? new Date(win.to).toLocaleString() : "n/a"}`,
    `Records: ${rows.length} exported of ${totalInScope} in scope`,
  ].filter(Boolean)) {
    const wrapped = doc.splitTextToSize(line, pageW - margin * 2);
    doc.text(wrapped, margin, y); y += wrapped.length * 12;
  }
  y += 4; doc.setTextColor(0);

  doc.setFont("helvetica", "bold"); doc.setFontSize(11);
  doc.text("Key metrics", margin, y); y += 14;
  doc.setFont("helvetica", "normal"); doc.setFontSize(10);
  const kpis: Array<[string, string]> = [
    ["Activities", String(s.n)],
    ["Completion", `${s.completionPct}%`],
    ["On-time", `${s.onTimePct}%`],
    ["Delayed", String(s.delayed)],
    ["Avg delay", `${s.avgDelay} d`],
  ];
  const colW = (pageW - margin * 2) / 2;
  kpis.forEach((k, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = margin + col * colW;
    const yy = y + row * 14;
    doc.setTextColor(110); doc.text(k[0], x, yy);
    doc.setTextColor(0); doc.text(k[1], x + 110, yy);
  });
  y += Math.ceil(kpis.length / 2) * 14 + 10;

  doc.setFont("helvetica", "bold"); doc.setFontSize(11);
  doc.text(`Activities (${rows.length})`, margin, y); y += 12;
  doc.setFont("helvetica", "bold"); doc.setFontSize(8);
  const headers = ["Project", "Activity", "Person", "Stage", "Status", "Delay"];
  const widths = [80, 150, 90, 80, 70, 45];
  let x = margin;
  headers.forEach((h, i) => { doc.text(h, x, y); x += widths[i]; });
  y += 4; doc.setDrawColor(200); doc.line(margin, y, pageW - margin, y); y += 10;
  doc.setFont("helvetica", "normal"); doc.setFontSize(8);
  const clip = (str: string, w: number) => String(doc.splitTextToSize(str || "-", w - 4)[0] ?? "");
  for (const r of rows) {
    if (y > pageH - margin) { doc.addPage(); y = margin; }
    x = margin;
    const cells = [r.project, r.activity, r.person, r.stage, r.status, `${r.delay}d`];
    cells.forEach((c, i) => { doc.text(clip(String(c ?? ""), widths[i]), x, y); x += widths[i]; });
    y += 11;
  }
  doc.save(`${ctx.kind}-${safeName(ctx.title)}-${rows.length}of${totalInScope}-${new Date().toISOString().slice(0, 10)}.pdf`);
}

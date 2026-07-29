/**
 * Client-side CSV/PDF export for the "My Activities" list. Pure browser
 * helpers — builds a Blob and triggers a download, no server round-trip.
 */
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

export type ExportableActivity = {
  title: string;
  status: string;
  start_date: string | null;
  due_date: string | null;
  tat_days: number | null;
  completed_at?: string | null;
  assignee?: string | null;
};

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "";
  // Keep YYYY-MM-DD if already a date; for ISO datetimes, take the date part.
  return v.length > 10 ? v.slice(0, 10) : v;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportActivitiesCsv(rows: ExportableActivity[], filename = "my-activities.csv") {
  const headers = ["Title", "Assignee", "Status", "Start", "Due", "TAT (days)", "Completed"];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.title,
        r.assignee ?? "",
        r.status.replace(/_/g, " "),
        fmtDate(r.start_date),
        fmtDate(r.due_date),
        r.tat_days ?? "",
        fmtDate(r.completed_at ?? null),
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  triggerDownload(blob, filename);
}

export function exportActivitiesPdf(
  rows: ExportableActivity[],
  opts: { filename?: string; title?: string; subtitle?: string } = {},
) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(opts.title ?? "My Activities", 40, 48);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(120);
  const subtitle = opts.subtitle ?? `Exported ${new Date().toLocaleString()} · ${rows.length} row${rows.length === 1 ? "" : "s"}`;
  doc.text(subtitle, 40, 66);
  doc.setTextColor(0);

  autoTable(doc, {
    startY: 84,
    head: [["Title", "Assignee", "Status", "Start", "Due", "TAT", "Completed"]],
    body: rows.map((r) => [
      r.title,
      r.assignee ?? "",
      r.status.replace(/_/g, " "),
      fmtDate(r.start_date),
      fmtDate(r.due_date),
      r.tat_days != null ? String(r.tat_days) : "",
      fmtDate(r.completed_at ?? null),
    ]),
    styles: { fontSize: 9, cellPadding: 6, overflow: "linebreak" },
    headStyles: { fillColor: [24, 24, 27], textColor: 255 },
    alternateRowStyles: { fillColor: [245, 245, 247] },
    columnStyles: {
      0: { cellWidth: pageWidth - 40 - 40 - (90 + 70 + 60 + 60 + 45 + 65) },
      1: { cellWidth: 90 },
      2: { cellWidth: 70 },
      3: { cellWidth: 60 },
      4: { cellWidth: 60 },
      5: { cellWidth: 45, halign: "right" },
      6: { cellWidth: 65 },
    },
    margin: { left: 40, right: 40 },
  });

  doc.save(opts.filename ?? "my-activities.pdf");
}

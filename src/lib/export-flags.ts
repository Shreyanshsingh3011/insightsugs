import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { DashboardData, FlagEntry } from "./dashboard-data";

function describeRootCause(f: FlagEntry): string {
  const owner = f.flagged_to?.person ?? "owner";
  const overrun = f.tat && f.days_taken ? Math.max(0, f.days_taken - f.tat) : (f.overdue_days ?? 0);
  const pct = f.tat && f.days_taken ? Math.round(((f.days_taken - f.tat) / f.tat) * 100) : null;
  if ((f.days_taken ?? 0) === 0 && (f.overdue_days ?? 0) === 0) {
    return `Not yet started — ${f.stage ?? "stage"} pending action from ${owner}.`;
  }
  if (pct !== null) return `Took ${f.days_taken}d vs ${f.tat}d TAT (${pct}% overrun, ${overrun}d late).`;
  return `${overrun}d overdue beyond planned TAT.`;
}

function nowStamp() {
  const d = new Date();
  return d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function rows(data: DashboardData, flagsOverride?: FlagEntry[]) {
  const flags = flagsOverride ?? data.flags ?? [];
  return flags.map((f) => ({
    id: f.id,
    activity: f.activity,
    owner: f.flagged_to?.person ?? "",
    stage: f.stage ?? "",
    severity: f.severity ?? "",
    status: f.status ?? "",
    tat: f.tat ?? "",
    days_taken: f.days_taken ?? "",
    overdue_days: f.overdue_days ?? 0,
    reason: f.reason_text?.trim() || f.reason || "Not specified",
    root_cause: describeRootCause(f),
    escalation: `L${f.escalation_level ?? 0}`,
    generated_at: new Date().toISOString(),
  }));
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportFlagsCsv(data: DashboardData) {
  const r = rows(data);
  const headers = ["ID","Activity","Owner","Stage","Severity","Status","TAT (d)","Days Taken","Overdue (d)","Reason","Root Cause","Escalation","Generated At"];
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [
    headers.map(esc).join(","),
    ...r.map((x) => [x.id,x.activity,x.owner,x.stage,x.severity,x.status,x.tat,x.days_taken,x.overdue_days,x.reason,x.root_cause,x.escalation,x.generated_at].map(esc).join(",")),
  ].join("\n");
  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `flags-report-${nowStamp()}.csv`);
}

export function exportFlagsPdf(data: DashboardData) {
  const r = rows(data);
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const generatedAt = new Date().toLocaleString();

  doc.setFontSize(16);
  doc.text("DelayLens — Flags Report", 40, 40);
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`Generated: ${generatedAt}`, 40, 58);
  doc.text(`Total flags: ${r.length}  |  Risk score: ${data.risk_score}  |  Delayed: ${data.totals.delayed}`, 40, 72);
  doc.setTextColor(0);

  autoTable(doc, {
    startY: 90,
    head: [["ID","Activity","Owner","Stage","Sev","TAT","Taken","Overdue","Reason","Root Cause"]],
    body: r.map((x) => [x.id, x.activity, x.owner, x.stage, x.severity, x.tat, x.days_taken, x.overdue_days, x.reason, x.root_cause]),
    styles: { fontSize: 8, cellPadding: 4, overflow: "linebreak" },
    headStyles: { fillColor: [30, 30, 50], textColor: 255 },
    columnStyles: {
      0: { cellWidth: 50 },
      1: { cellWidth: 130 },
      2: { cellWidth: 90 },
      3: { cellWidth: 70 },
      4: { cellWidth: 45 },
      5: { cellWidth: 35 },
      6: { cellWidth: 40 },
      7: { cellWidth: 45 },
      8: { cellWidth: 90 },
      9: { cellWidth: 160 },
    },
    didDrawPage: (d) => {
      const page = doc.getNumberOfPages();
      doc.setFontSize(8); doc.setTextColor(140);
      doc.text(`Page ${page}`, d.settings.margin.left, doc.internal.pageSize.getHeight() - 16);
    },
  });

  doc.save(`flags-report-${nowStamp()}.pdf`);
}

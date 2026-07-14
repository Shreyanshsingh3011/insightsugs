import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

type AnyFlag = {
  id?: string;
  title?: string;
  message?: string;
  severity?: string;
  category?: string;
  reason?: string;
  reason_text?: string;
  activity?: string;
  stage?: string;
  status?: string;
  tat?: number | null;
  days_taken?: number | null;
  overdue_days?: number | null;
  escalation_level?: number;
  flagged_to?: { person?: string; email?: string };
  row?: number;
  sheet?: string;
};

export type IncidentReportInput = {
  project?: string;
  summary?: string;
  totals?: Record<string, number>;
  risk_score?: number | { score?: number };
  flags?: AnyFlag[];
  anomalies?: AnyFlag[];
  filters?: Record<string, unknown>;
};

const ROOT_CAUSE_BUCKETS: [RegExp, string][] = [
  [/vendor|supplier|contractor/i, "Vendor / third-party"],
  [/approval|sign-?off|clearance/i, "Approval bottleneck"],
  [/document|paperwork|signature|kyc/i, "Documentation gap"],
  [/site|field|access|visit/i, "Site / field access"],
  [/payment|invoice|billing|dues/i, "Payment / billing"],
  [/technical|system|meter|equipment|hardware/i, "Technical / equipment"],
  [/manpower|resource|staff|absent/i, "Resource shortage"],
  [/weather|monsoon|rain|force[- ]majeure/i, "External / weather"],
  [/tat|overrun|delay|late/i, "TAT overrun"],
];

function bucketOf(f: AnyFlag): string {
  const text = [f.category, f.reason, f.reason_text, f.message, f.title, f.stage].filter(Boolean).join(" ");
  for (const [re, name] of ROOT_CAUSE_BUCKETS) if (re.test(text)) return name;
  if ((f.overdue_days ?? 0) > 0) return "TAT overrun";
  return "Uncategorised";
}

function severityRank(s?: string) {
  const v = (s || "").toLowerCase();
  if (v.includes("critical")) return 4;
  if (v.includes("high")) return 3;
  if (v.includes("med")) return 2;
  if (v.includes("low")) return 1;
  return 0;
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function exportIncidentReportPdf(input: IncidentReportInput) {
  const items: AnyFlag[] = [...(input.flags ?? []), ...(input.anomalies ?? [])];
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const generatedAt = new Date().toLocaleString();
  const pageWidth = doc.internal.pageSize.getWidth();

  // Header
  doc.setFontSize(18);
  doc.text("Incident Report", 40, 48);
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text(`Generated: ${generatedAt}`, 40, 66);
  if (input.project) doc.text(`Project: ${input.project}`, 40, 80);
  doc.setTextColor(0);

  // Summary block
  const risk = typeof input.risk_score === "number" ? input.risk_score : (input.risk_score as any)?.score;
  const totals = input.totals || {};
  const bits = [
    items.length ? `${items.length} incident${items.length === 1 ? "" : "s"} in scope` : "No incidents detected",
    risk != null ? `Risk score: ${risk}` : "",
    Object.entries(totals).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join("  |  "),
  ].filter(Boolean);
  doc.setFontSize(10);
  doc.text(bits.join("   •   "), 40, 100, { maxWidth: pageWidth - 80 });

  if (input.summary) {
    doc.setFontSize(9);
    doc.setTextColor(90);
    doc.text(String(input.summary).slice(0, 600), 40, 120, { maxWidth: pageWidth - 80 });
    doc.setTextColor(0);
  }

  // Applied filters row
  const filterEntries = Object.entries(input.filters || {}).filter(([, v]) => v != null && v !== "");
  let cursor = 150;
  if (filterEntries.length) {
    doc.setFontSize(9);
    doc.setTextColor(60);
    doc.text(`Applied filters: ${filterEntries.map(([k, v]) => `${k}=${String(v)}`).join("  ·  ")}`, 40, cursor, { maxWidth: pageWidth - 80 });
    doc.setTextColor(0);
    cursor += 18;
  }

  // Group by root cause
  const grouped = new Map<string, AnyFlag[]>();
  for (const f of items) {
    const b = bucketOf(f);
    if (!grouped.has(b)) grouped.set(b, []);
    grouped.get(b)!.push(f);
  }

  // Root-cause summary table
  const catRows = [...grouped.entries()]
    .map(([cat, arr]) => {
      const overdue = arr.reduce((s, x) => s + (x.overdue_days ?? 0), 0);
      const high = arr.filter((x) => severityRank(x.severity) >= 3).length;
      return [cat, String(arr.length), String(high), overdue ? `${overdue}d` : "—"];
    })
    .sort((a, b) => Number(b[1]) - Number(a[1]));

  autoTable(doc, {
    startY: cursor,
    head: [["Root-cause category", "Incidents", "High/Critical", "Total overdue"]],
    body: catRows,
    styles: { fontSize: 9, cellPadding: 5 },
    headStyles: { fillColor: [30, 30, 50], textColor: 255 },
    theme: "grid",
  });

  // Per-category detailed tables
  const sortedGroups = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [cat, arr] of sortedGroups) {
    const y = (doc as any).lastAutoTable?.finalY ?? cursor;
    if (y > 720) doc.addPage();
    const startY = ((doc as any).lastAutoTable?.finalY ?? cursor) + 24;
    doc.setFontSize(11);
    doc.text(`${cat} — ${arr.length}`, 40, startY - 8);
    autoTable(doc, {
      startY,
      head: [["Activity / Title", "Owner", "Severity", "Status", "Overdue", "Reason / Root cause"]],
      body: arr
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || (b.overdue_days ?? 0) - (a.overdue_days ?? 0))
        .map((f) => {
          const owner = f.flagged_to?.person || "—";
          const overrun = f.tat && f.days_taken ? `${Math.max(0, (f.days_taken ?? 0) - (f.tat ?? 0))}d` : (f.overdue_days ? `${f.overdue_days}d` : "—");
          const reason = f.reason_text?.trim() || f.reason || f.message || f.title || "—";
          const rc = f.tat && f.days_taken ? `Took ${f.days_taken}d vs ${f.tat}d TAT` : (f.stage ? `Stage: ${f.stage}` : "");
          const detail = rc ? `${reason} — ${rc}` : reason;
          return [f.activity || f.title || "—", owner, f.severity || "info", f.status || "—", overrun, detail];
        }),
      styles: { fontSize: 8, cellPadding: 4, overflow: "linebreak" },
      headStyles: { fillColor: [50, 50, 80], textColor: 255 },
      columnStyles: {
        0: { cellWidth: 120 },
        1: { cellWidth: 70 },
        2: { cellWidth: 50 },
        3: { cellWidth: 55 },
        4: { cellWidth: 45 },
        5: { cellWidth: "auto" },
      },
      theme: "striped",
      didDrawPage: () => {
        const page = doc.getNumberOfPages();
        doc.setFontSize(8);
        doc.setTextColor(140);
        doc.text(`Page ${page}`, 40, doc.internal.pageSize.getHeight() - 16);
        doc.setTextColor(0);
      },
    });
  }

  doc.save(`incident-report-${nowStamp()}.pdf`);
}

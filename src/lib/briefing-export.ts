import { jsPDF } from "jspdf";

export type BriefingExport = {
  scope: string;
  week_start: string;
  week_end: string;
  content_markdown: string;
};

function safeFilePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "weekly-briefing";
}

function normalizePdfText(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2022]/g, "*")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/[^\x09\x0A\x20-\x7E\xA0-\xFF]/g, "");
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

export function briefingFilename(briefing: BriefingExport, extension: "pdf" | "md") {
  const scope = briefing.scope === "org" ? "org" : "user";
  return `${safeFilePart(`${scope}-weekly-report-${briefing.week_start}-to-${briefing.week_end}`)}.${extension}`;
}

export function exportBriefingMarkdown(briefing: BriefingExport) {
  const blob = new Blob([briefing.content_markdown], { type: "text/markdown;charset=utf-8" });
  triggerDownload(blob, briefingFilename(briefing, "md"));
}

export function exportBriefingPdf(briefing: BriefingExport) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 48;
  const maxWidth = pageWidth - margin * 2;
  let y = margin;

  const ensureRoom = (height: number) => {
    if (y + height > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  };

  const drawText = (
    text: string,
    size: number,
    opts: { bold?: boolean; color?: [number, number, number]; indent?: number } = {},
  ) => {
    const indent = opts.indent ?? 0;
    doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    doc.setFontSize(size);
    const [r, g, b] = opts.color ?? [30, 30, 30];
    doc.setTextColor(r, g, b);
    const lines = doc.splitTextToSize(normalizePdfText(text), maxWidth - indent) as string[];
    const lineHeight = size * 1.35;
    for (const line of lines) {
      ensureRoom(lineHeight);
      doc.text(line, margin + indent, y);
      y += lineHeight;
    }
  };

  const scopeLabel = briefing.scope === "org" ? "Organization weekly report" : "My weekly report";
  drawText(scopeLabel, 18, { bold: true });
  drawText(`${briefing.week_start} to ${briefing.week_end} · Exported ${new Date().toLocaleString()}`, 9, {
    color: [110, 110, 110],
  });
  y += 12;
  doc.setDrawColor(220, 220, 220);
  doc.line(margin, y, pageWidth - margin, y);
  y += 18;

  for (const rawLine of briefing.content_markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      y += 8;
      continue;
    }
    if (line.startsWith("# ")) {
      drawText(line.replace(/^#\s+/, ""), 16, { bold: true });
      y += 6;
      continue;
    }
    if (line.startsWith("## ")) {
      y += 8;
      drawText(line.replace(/^##\s+/, ""), 13, { bold: true });
      y += 4;
      continue;
    }
    if (line.startsWith("- ")) {
      drawText(`• ${line.slice(2)}`, 10, { indent: 12 });
      continue;
    }
    drawText(line, 10.5);
  }

  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(145, 145, 145);
    doc.text(`Weekly report · Page ${i} of ${pageCount}`, pageWidth / 2, pageHeight - 20, {
      align: "center",
    });
  }

  doc.save(briefingFilename(briefing, "pdf"));
}
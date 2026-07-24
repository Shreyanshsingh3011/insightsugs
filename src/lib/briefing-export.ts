import { jsPDF } from "jspdf";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  LevelFormat,
  BorderStyle,
  Header,
  Footer,
  PageNumber,
} from "docx";

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

export function briefingFilename(briefing: BriefingExport, extension: "pdf" | "md" | "docx") {
  const scope = briefing.scope === "org" ? "org" : "user";
  return `${safeFilePart(`${scope}-weekly-report-${briefing.week_start}-to-${briefing.week_end}`)}.${extension}`;
}

// Parse inline markdown (**bold**, *italic*, `code`, [text](url)) into TextRuns.
function parseInlineRuns(text: string, baseOpts: { bold?: boolean; italics?: boolean; color?: string; size?: number } = {}): TextRun[] {
  const runs: TextRun[] = [];
  // Tokenize by **bold**, *italic*/_italic_, `code`, [text](url)
  const regex = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (t: string, opts: { bold?: boolean; italics?: boolean; color?: string; size?: number } = {}) => {
    if (!t) return;
    runs.push(new TextRun({ text: t, bold: opts.bold ?? baseOpts.bold, italics: opts.italics ?? baseOpts.italics, color: opts.color ?? baseOpts.color, size: opts.size ?? baseOpts.size, font: "Calibri" }));
  };
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**") || tok.startsWith("__")) push(tok.slice(2, -2), { bold: true });
    else if (tok.startsWith("`")) push(tok.slice(1, -1), { color: "9333EA" });
    else if (tok.startsWith("[")) {
      const mm = /^\[([^\]]+)]\(([^)]+)\)$/.exec(tok);
      if (mm) push(mm[1], { color: "1D4ED8" });
    } else push(tok.slice(1, -1), { italics: true });
    last = m.index + tok.length;
  }
  if (last < text.length) push(text.slice(last));
  return runs.length ? runs : [new TextRun({ text, font: "Calibri", size: baseOpts.size, bold: baseOpts.bold, italics: baseOpts.italics, color: baseOpts.color })];
}

export async function exportBriefingDocx(briefing: BriefingExport) {
  const scopeLabel = briefing.scope === "org" ? "Organization Weekly Report" : "My Weekly Report";
  const md = briefing.content_markdown.replace(/^#\s+.+\n+/, "");
  const blocks = parseMarkdownBlocks(md);

  const accent = "EA580C";
  const muted = "6E7178";
  const ink = "18181B";

  const children: Paragraph[] = [];

  // Cover
  children.push(
    new Paragraph({
      spacing: { after: 60 },
      children: [new TextRun({ text: (briefing.scope === "org" ? "ORGANIZATION" : "PERSONAL") + " · WEEKLY REPORT", bold: true, color: accent, size: 18, font: "Calibri" })],
    }),
    new Paragraph({
      spacing: { after: 120 },
      children: [new TextRun({ text: scopeLabel, bold: true, size: 44, color: ink, font: "Calibri" })],
    }),
    new Paragraph({
      spacing: { after: 60 },
      children: [
        new TextRun({ text: "Reporting period: ", color: muted, size: 20, font: "Calibri" }),
        new TextRun({ text: `${briefing.week_start} → ${briefing.week_end}`, bold: true, size: 20, color: ink, font: "Calibri" }),
      ],
    }),
    new Paragraph({
      spacing: { after: 240 },
      children: [
        new TextRun({ text: "Generated: ", color: muted, size: 20, font: "Calibri" }),
        new TextRun({ text: new Date().toLocaleString(), bold: true, size: 20, color: ink, font: "Calibri" }),
      ],
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "E1E3E8", space: 8 } },
    }),
  );

  for (const b of blocks) {
    switch (b.kind) {
      case "h1":
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 }, children: parseInlineRuns(b.text, { bold: true, size: 36, color: ink }) }));
        break;
      case "h2":
        children.push(new Paragraph({
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 220, after: 100 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: accent, space: 4 } },
          children: parseInlineRuns(b.text, { bold: true, size: 28, color: ink }),
        }));
        break;
      case "h3":
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 160, after: 80 }, children: parseInlineRuns(b.text, { bold: true, size: 24, color: ink }) }));
        break;
      case "bullet":
        children.push(new Paragraph({ numbering: { reference: "briefing-bullets", level: 0 }, spacing: { after: 60 }, children: parseInlineRuns(b.text, { size: 22, color: ink }) }));
        break;
      case "para":
        children.push(new Paragraph({ spacing: { after: 120, line: 320 }, children: parseInlineRuns(b.text, { size: 22, color: ink }) }));
        break;
      case "spacer":
        children.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: "", font: "Calibri" })] }));
        break;
    }
  }

  const doc = new Document({
    creator: "DelayLens",
    title: scopeLabel,
    styles: {
      default: { document: { run: { font: "Calibri", size: 22 } } },
    },
    numbering: {
      config: [{
        reference: "briefing-bullets",
        levels: [{
          level: 0,
          format: LevelFormat.BULLET,
          text: "•",
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 480, hanging: 240 } }, run: { color: accent } },
        }],
      }],
    },
    sections: [{
      properties: { page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } },
      headers: {
        default: new Header({ children: [new Paragraph({ children: [new TextRun({ text: `${briefing.scope === "org" ? "Organization" : "Personal"} weekly report`, color: muted, size: 18, font: "Calibri" })] })] }),
      },
      footers: {
        default: new Footer({ children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [
            new TextRun({ text: `${briefing.week_start} → ${briefing.week_end}  ·  Page `, color: muted, size: 18, font: "Calibri" }),
            new TextRun({ children: [PageNumber.CURRENT], color: muted, size: 18, font: "Calibri" }),
            new TextRun({ text: " of ", color: muted, size: 18, font: "Calibri" }),
            new TextRun({ children: [PageNumber.TOTAL_PAGES], color: muted, size: 18, font: "Calibri" }),
          ],
        })] }),
      },
      children,
    }],
  });

  const blob = await Packer.toBlob(doc);
  triggerDownload(blob, briefingFilename(briefing, "docx"));
}

export function exportBriefingMarkdown(briefing: BriefingExport) {
  const scopeLabel = briefing.scope === "org" ? "Organization Weekly Report" : "My Weekly Report";
  const header = [
    `# ${scopeLabel}`,
    ``,
    `**Reporting period:** ${briefing.week_start} → ${briefing.week_end}  `,
    `**Generated:** ${new Date().toLocaleString()}`,
    ``,
    `---`,
    ``,
  ].join("\n");
  // Strip a duplicate leading H1 that the runner may already include.
  const body = briefing.content_markdown.replace(/^#\s+.+\n+/, "");
  const blob = new Blob([header + body], { type: "text/markdown;charset=utf-8" });
  triggerDownload(blob, briefingFilename(briefing, "md"));
}

type Block =
  | { kind: "h1"; text: string }
  | { kind: "h2"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "para"; text: string }
  | { kind: "spacer" };

function parseMarkdownBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.split(/\r?\n/);
  let paraBuf: string[] = [];
  const flush = () => {
    if (paraBuf.length) {
      blocks.push({ kind: "para", text: paraBuf.join(" ").trim() });
      paraBuf = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      blocks.push({ kind: "spacer" });
      continue;
    }
    if (line.startsWith("### ")) {
      flush();
      blocks.push({ kind: "h3", text: line.replace(/^###\s+/, "") });
      continue;
    }
    if (line.startsWith("## ")) {
      flush();
      blocks.push({ kind: "h2", text: line.replace(/^##\s+/, "") });
      continue;
    }
    if (line.startsWith("# ")) {
      flush();
      blocks.push({ kind: "h1", text: line.replace(/^#\s+/, "") });
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flush();
      blocks.push({ kind: "bullet", text: line.replace(/^[-*]\s+/, "") });
      continue;
    }
    paraBuf.push(line);
  }
  flush();
  return blocks;
}

export function exportBriefingPdf(briefing: BriefingExport) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 56;
  const contentWidth = pageWidth - margin * 2;

  // ---------- Colors ----------
  const ink: [number, number, number] = [24, 24, 27];
  const muted: [number, number, number] = [110, 113, 120];
  const rule: [number, number, number] = [225, 227, 232];
  const accent: [number, number, number] = [234, 88, 12]; // brand orange
  const chipBg: [number, number, number] = [244, 244, 245];

  let y = margin;

  const setColor = (c: [number, number, number]) => doc.setTextColor(c[0], c[1], c[2]);

  const ensureRoom = (needed: number) => {
    if (y + needed > pageHeight - margin - 30) {
      doc.addPage();
      y = margin;
    }
  };

  const drawParagraph = (
    text: string,
    size: number,
    opts: {
      bold?: boolean;
      italic?: boolean;
      color?: [number, number, number];
      indent?: number;
      lineHeightMult?: number;
    } = {},
  ) => {
    const indent = opts.indent ?? 0;
    const style = opts.bold ? (opts.italic ? "bolditalic" : "bold") : opts.italic ? "italic" : "normal";
    doc.setFont("helvetica", style);
    doc.setFontSize(size);
    setColor(opts.color ?? ink);
    const lines = doc.splitTextToSize(normalizePdfText(text), contentWidth - indent) as string[];
    const lineHeight = size * (opts.lineHeightMult ?? 1.4);
    for (const line of lines) {
      ensureRoom(lineHeight);
      doc.text(line, margin + indent, y);
      y += lineHeight;
    }
  };

  const drawBullet = (text: string) => {
    const size = 10.5;
    const indent = 18;
    const bulletX = margin + 4;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(size);
    setColor(ink);
    const lines = doc.splitTextToSize(normalizePdfText(text), contentWidth - indent) as string[];
    const lineHeight = size * 1.45;
    ensureRoom(lineHeight);
    // Orange dot
    doc.setFillColor(accent[0], accent[1], accent[2]);
    doc.circle(bulletX, y - size * 0.32, 1.8, "F");
    setColor(ink);
    lines.forEach((line, i) => {
      if (i > 0) ensureRoom(lineHeight);
      doc.text(line, margin + indent, y);
      y += lineHeight;
    });
  };

  const hr = (color = rule) => {
    ensureRoom(14);
    doc.setDrawColor(color[0], color[1], color[2]);
    doc.setLineWidth(0.5);
    doc.line(margin, y, pageWidth - margin, y);
    y += 14;
  };

  // ---------- Cover header ----------
  const scopeLabel = briefing.scope === "org" ? "ORGANIZATION" : "PERSONAL";
  // Accent bar
  doc.setFillColor(accent[0], accent[1], accent[2]);
  doc.rect(margin, y, 36, 4, "F");
  y += 18;

  // Eyebrow
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  setColor(accent);
  doc.text(`${scopeLabel} · WEEKLY REPORT`, margin, y);
  y += 22;

  // Title
  drawParagraph("Weekly operations briefing", 26, { bold: true, lineHeightMult: 1.15 });
  y += 4;

  // Meta chips
  const chip = (label: string, value: string, x: number) => {
    const padX = 10;
    const padY = 6;
    const labelText = `${label}  `;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    setColor(muted);
    const lw = doc.getTextWidth(labelText);
    doc.setFont("helvetica", "bold");
    setColor(ink);
    const vw = doc.getTextWidth(value);
    const w = lw + vw + padX * 2;
    doc.setFillColor(chipBg[0], chipBg[1], chipBg[2]);
    doc.roundedRect(x, y - 12, w, 20, 3, 3, "F");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    setColor(muted);
    doc.text(labelText, x + padX, y);
    doc.setFont("helvetica", "bold");
    setColor(ink);
    doc.text(value, x + padX + lw, y);
    return x + w + 8;
  };
  y += 8;
  let cx = margin;
  cx = chip("Period", `${briefing.week_start} → ${briefing.week_end}`, cx);
  cx = chip("Generated", new Date().toLocaleDateString(), cx);
  y += 18;

  hr();

  // ---------- Body ----------
  // Strip a duplicate leading H1 that the runner already includes
  const md = briefing.content_markdown.replace(/^#\s+.+\n+/, "");
  const blocks = parseMarkdownBlocks(md);

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    switch (b.kind) {
      case "h1":
        y += 6;
        drawParagraph(b.text, 18, { bold: true, lineHeightMult: 1.2 });
        y += 4;
        break;
      case "h2":
        y += 14;
        ensureRoom(30);
        // Small accent tick
        doc.setFillColor(accent[0], accent[1], accent[2]);
        doc.rect(margin, y - 10, 3, 14, "F");
        drawParagraph(b.text, 13.5, { bold: true, indent: 10, lineHeightMult: 1.2 });
        y += 4;
        break;
      case "h3":
        y += 8;
        drawParagraph(b.text, 11.5, { bold: true, color: muted, lineHeightMult: 1.2 });
        y += 2;
        break;
      case "bullet":
        drawBullet(b.text);
        break;
      case "para":
        drawParagraph(b.text, 10.5, { lineHeightMult: 1.5 });
        y += 4;
        break;
      case "spacer":
        y += 4;
        break;
    }
  }

  // ---------- Footer ----------
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setDrawColor(rule[0], rule[1], rule[2]);
    doc.setLineWidth(0.5);
    doc.line(margin, pageHeight - 40, pageWidth - margin, pageHeight - 40);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    setColor(muted);
    doc.text(
      `${briefing.scope === "org" ? "Organization" : "Personal"} weekly report · ${briefing.week_start} → ${briefing.week_end}`,
      margin,
      pageHeight - 24,
    );
    doc.text(`Page ${i} of ${pageCount}`, pageWidth - margin, pageHeight - 24, { align: "right" });
  }

  doc.save(briefingFilename(briefing, "pdf"));
}

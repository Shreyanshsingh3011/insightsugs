// Server-only helpers for document parsing, embedding, and AI summarization.
// Never import this from client code.

import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY!;

function isQuotaOrBilling(status: number, text: string) {
  return status === 402 || status === 429 || status >= 500 || /payment required|credits exhausted|quota|rate limit/i.test(text);
}

async function embedTextsWithGemini(inputs: string[]): Promise<number[][]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY on the server");
  const model = "models/gemini-embedding-001";
  const BATCH = 96;
  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${model}:batchEmbedContents?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: batch.map((text) => ({
            model,
            content: { parts: [{ text }] },
            taskType: "RETRIEVAL_DOCUMENT",
            outputDimensionality: 768,
          })),
        }),
      },
    );
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Gemini embedding failed (${res.status}): ${t.slice(0, 200)}`);
    }
    const json = (await res.json()) as { embeddings?: { values?: number[] }[] };
    for (const row of json.embeddings ?? []) out.push(row.values ?? []);
  }
  return out;
}

export function getAdminSupabase() {
  return createClient<Database>(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ----- Text extraction -------------------------------------------------------

export type ExtractedText = {
  pages: { page: number; text: string }[];
  pageCount: number;
};

async function extractPdf(buffer: ArrayBuffer): Promise<ExtractedText> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const pageCount = pdf.numPages;
  const { text } = await extractText(pdf, { mergePages: false });
  const arr = Array.isArray(text) ? text : [String(text ?? "")];
  const pages = arr.map((t, i) => ({ page: i + 1, text: String(t ?? "") }));
  return { pages, pageCount };
}

async function extractDocx(buffer: ArrayBuffer): Promise<ExtractedText> {
  const mammoth = (await import("mammoth")).default ?? (await import("mammoth"));
  // mammoth ESM export
  const { value } = await (mammoth as any).extractRawText({ buffer: Buffer.from(buffer) });
  return { pages: [{ page: 1, text: String(value ?? "") }], pageCount: 1 };
}

async function extractPlain(buffer: ArrayBuffer): Promise<ExtractedText> {
  const text = new TextDecoder().decode(buffer);
  return { pages: [{ page: 1, text }], pageCount: 1 };
}

async function ocrImage(buffer: ArrayBuffer, mime: string): Promise<string> {
  const b64 = Buffer.from(buffer).toString("base64");
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": LOVABLE_API_KEY,
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Extract ALL readable text from this image. Preserve line breaks. " +
                "Return only the extracted text — no commentary.",
            },
            { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OCR failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content ?? "";
}

async function ocrPdfWithGemini(
  buffer: ArrayBuffer,
  name: string,
): Promise<ExtractedText | null> {
  if (buffer.byteLength >= 15 * 1024 * 1024) return null;
  const b64 = Buffer.from(buffer).toString("base64");
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": LOVABLE_API_KEY,
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "OCR every page of this PDF, including scanned pages, images, tables, and handwriting. " +
                "Return plain text with [PAGE n] markers before each page's text. " +
                "Preserve tables as tab-separated rows. No commentary.",
            },
            {
              type: "file",
              file: {
                filename: name || "document.pdf",
                file_data: `data:application/pdf;base64,${b64}`,
              },
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = j.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) return null;
  const pages = splitOcrPages(text);
  return { pages, pageCount: pages.length };
}

export async function extractText(
  buffer: ArrayBuffer,
  mime: string,
  name: string,
): Promise<ExtractedText> {
  const lower = name.toLowerCase();
  if (mime === "application/pdf" || lower.endsWith(".pdf")) {
    const result = await extractPdf(buffer);
    const total = result.pages.reduce((n, p) => n + p.text.trim().length, 0);
    const avgPerPage = total / Math.max(1, result.pageCount);
    // OCR when the native extractor got very little text — indicates a
    // scanned/image PDF. Threshold: <500 chars total OR <80 chars/page avg.
    const needsOcr = total < 500 || avgPerPage < 80;
    if (needsOcr && LOVABLE_API_KEY) {
      const ocr = await ocrPdfWithGemini(buffer, name);
      if (ocr) {
        const ocrTotal = ocr.pages.reduce((n, p) => n + p.text.trim().length, 0);
        if (ocrTotal > total) return ocr;
      }
    }
    return result;
  }
  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lower.endsWith(".docx")
  ) {
    return extractDocx(buffer);
  }
  if (mime.startsWith("image/")) {
    const text = await ocrImage(buffer, mime);
    return { pages: [{ page: 1, text }], pageCount: 1 };
  }
  if (
    mime.startsWith("text/") ||
    lower.endsWith(".txt") ||
    lower.endsWith(".md") ||
    lower.endsWith(".csv")
  ) {
    return extractPlain(buffer);
  }
  // Best-effort fallback
  return extractPlain(buffer);
}

function splitOcrPages(raw: string): { page: number; text: string }[] {
  const parts = raw.split(/\[PAGE\s*(\d+)\]/i);
  // parts: [pre, "1", text1, "2", text2, ...]
  if (parts.length <= 1) return [{ page: 1, text: raw }];
  const pages: { page: number; text: string }[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const num = parseInt(parts[i] ?? "", 10) || pages.length + 1;
    pages.push({ page: num, text: (parts[i + 1] ?? "").trim() });
  }
  return pages.length ? pages : [{ page: 1, text: raw }];
}

// ----- Chunking --------------------------------------------------------------

export type Chunk = { index: number; content: string; pageNo: number | null };

export function chunkText(
  pages: ExtractedText["pages"],
  size = 1000,
  overlap = 150,
): Chunk[] {
  const chunks: Chunk[] = [];
  let idx = 0;
  for (const p of pages) {
    const text = p.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (text.length <= size) {
      chunks.push({ index: idx++, content: text, pageNo: p.page });
      continue;
    }
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + size, text.length);
      chunks.push({ index: idx++, content: text.slice(start, end), pageNo: p.page });
      if (end === text.length) break;
      start = end - overlap;
    }
  }
  return chunks;
}

// ----- Embeddings ------------------------------------------------------------

export async function embedTexts(inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];
  if (!LOVABLE_API_KEY) return embedTextsWithGemini(inputs);
  // Larger batches reduce HTTP round-trips for big documents.
  const BATCH = 96;
  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH);
    const res = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": LOVABLE_API_KEY,
      },
      body: JSON.stringify({
        model: "google/gemini-embedding-001",
        input: batch,
        dimensions: 768,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      if (isQuotaOrBilling(res.status, t) && process.env.GEMINI_API_KEY) {
        return embedTextsWithGemini(inputs);
      }
      throw new Error(`Embedding failed (${res.status}): ${t.slice(0, 200)}`);
    }
    const j = (await res.json()) as { data?: { embedding: number[] }[] };
    for (const row of j.data ?? []) out.push(row.embedding);
  }
  return out;
}

// ----- Summary + key points --------------------------------------------------

export async function summarize(text: string, fileName: string) {
  const trimmed = text.slice(0, 18000); // keep token use modest
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": LOVABLE_API_KEY,
    },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [
        {
          role: "system",
          content:
            "You summarize business documents. Return strict JSON: " +
            '{"summary": "<2-4 sentence overview>", "key_points": ["...", "..."]}. ' +
            "No commentary, no code fences.",
        },
        {
          role: "user",
          content: `Document: ${fileName}\n\nContent:\n${trimmed}`,
        },
      ],
    }),
  });
  if (!res.ok) {
    return { summary: null as string | null, key_points: [] as string[] };
  }
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = (j.choices?.[0]?.message?.content ?? "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(raw);
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : null,
      key_points: Array.isArray(parsed.key_points)
        ? parsed.key_points.map((p: unknown) => String(p)).slice(0, 12)
        : [],
    };
  } catch {
    return { summary: raw.slice(0, 600) || null, key_points: [] };
  }
}

// ----- Vector formatting -----------------------------------------------------

export function toPgVector(v: number[]): string {
  return "[" + v.join(",") + "]";
}

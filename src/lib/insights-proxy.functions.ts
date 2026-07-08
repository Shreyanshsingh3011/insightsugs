import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const InputSchema = z.object({
  url: z.string().url().max(3000),
  // Optional Google Sheets tab name (e.g. "PSPCL", "NIT-58"). When the URL is
  // a Google Sheets link, this picks the worksheet. Falls back to gid in the
  // URL (#gid=...) and then to the first sheet.
  tab: z.string().max(200).optional(),
});

const GATEWAY = "https://connector-gateway.lovable.dev/google_sheets/v4";

function assertSafePublicUrl(raw: string): URL {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const isLocalPublicApi = url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1") && url.pathname.startsWith("/api/public/");
  if (url.protocol !== "https:" && !isLocalPublicApi) throw new Error("Only https links are supported.");
  if (isLocalPublicApi) return url;
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    throw new Error("Only public analytics links are supported.");
  }
  return url;
}

function isGoogleSheetsUrl(u: URL): boolean {
  return u.hostname === "docs.google.com" && u.pathname.includes("/spreadsheets/d/");
}

function parseSheetsUrl(u: URL): { id: string; gid?: string } {
  const m = u.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const id = m ? m[1] : "";
  // gid can live in the hash (#gid=123) or the query (?gid=123)
  const hash = u.hash || "";
  const hashGid = hash.match(/gid=(\d+)/)?.[1];
  const qGid = u.searchParams.get("gid") || undefined;
  return { id, gid: hashGid ?? qGid };
}

async function fetchGoogleSheetRows(u: URL, tabHint: string | undefined): Promise<{
  connector: string;
  data: Record<string, string>[];
  generated_at: string;
  warning?: string;
}> {
  const lovable = process.env.LOVABLE_API_KEY;
  const key = process.env.GOOGLE_SHEETS_API_KEY;
  if (!lovable || !key) {
    throw new Error("Google Sheets connector is not configured — link it in Connectors.");
  }
  const parsed = parseSheetsUrl(u);
  if (!parsed.id) throw new Error("Could not extract spreadsheet id from URL.");
  const headers = {
    Authorization: `Bearer ${lovable}`,
    "X-Connection-Api-Key": key,
    Accept: "application/json",
  };

  // Pick a worksheet: explicit tab hint > gid match > first sheet.
  const metaRes = await fetch(
    `${GATEWAY}/spreadsheets/${parsed.id}?fields=properties.title,sheets.properties(sheetId,title,index)`,
    { headers },
  );
  if (!metaRes.ok) throw new Error(`Google Sheets metadata HTTP ${metaRes.status}: ${await metaRes.text()}`);
  const meta = (await metaRes.json()) as {
    properties?: { title?: string };
    sheets?: { properties: { sheetId: number; title: string; index: number } }[];
  };
  const sheets = (meta.sheets ?? []).slice().sort((a, b) => a.properties.index - b.properties.index);
  if (!sheets.length) throw new Error("Spreadsheet has no worksheets.");
  let chosen: { sheetId: number; title: string } | undefined;
  let tabFallbackReason: string | undefined;
  const available = sheets.map(s => s.properties.title);
  if (tabHint) {
    const needle = tabHint.trim().toLowerCase();
    chosen = sheets.find(s => s.properties.title.trim().toLowerCase() === needle)?.properties
      ?? sheets.find(s => s.properties.title.toLowerCase().includes(needle))?.properties;
    if (!chosen) {
      tabFallbackReason = `Tab "${tabHint}" not found in "${meta.properties?.title ?? parsed.id}". Available tabs: ${available.map(t => `"${t}"`).join(", ")}. Falling back to ${parsed.gid ? "#gid match" : "first tab"}.`;
      console.warn(`[insights-proxy] ${tabFallbackReason}`);
    }
  }
  if (!chosen && parsed.gid) {
    const gid = Number(parsed.gid);
    chosen = sheets.find(s => s.properties.sheetId === gid)?.properties;
    if (!chosen && !tabFallbackReason) {
      tabFallbackReason = `gid=${gid} not found in "${meta.properties?.title ?? parsed.id}". Available tabs: ${available.map(t => `"${t}"`).join(", ")}. Falling back to first tab.`;
      console.warn(`[insights-proxy] ${tabFallbackReason}`);
    }
  }
  if (!chosen) chosen = sheets[0].properties;

  const range = `${chosen.title}!A1:ZZ10000`;
  const valRes = await fetch(
    `${GATEWAY}/spreadsheets/${parsed.id}/values/${range}?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
    { headers },
  );
  if (!valRes.ok) throw new Error(`Google Sheets values HTTP ${valRes.status}: ${await valRes.text()}`);
  const vjson = (await valRes.json()) as { values?: string[][] };
  const values = vjson.values ?? [];
  if (values.length === 0) {
    return { connector: `${meta.properties?.title ?? chosen.title} — view`, data: [], generated_at: new Date().toISOString(), warning: tabFallbackReason };
  }
  const cols = values[0].map((h, i) => String(h || `Col${i + 1}`).trim());
  const rows: Record<string, string>[] = values.slice(1).map(r => {
    const obj: Record<string, string> = {};
    cols.forEach((h, i) => (obj[h] = String(r[i] ?? "")));
    return obj;
  });
  return {
    connector: `${meta.properties?.title ?? chosen.title} — view`,
    data: rows,
    generated_at: new Date().toISOString(),
    warning: tabFallbackReason,
  };
}

export const fetchInsightUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }) => {
    const url = assertSafePublicUrl(data.url);
    const started = Date.now();

    // Google Sheets URL → route through the Google Sheets connector so the
    // registry can point at live sheets instead of sheet2api proxies.
    if (isGoogleSheetsUrl(url)) {
      const payload = await fetchGoogleSheetRows(url, data.tab);
      return { payload, fetchedAt: Date.now(), fetchMs: Date.now() - started, url: url.toString() };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Source returned HTTP ${res.status}`);
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("Source did not return JSON.");
      }
      const payload = await res.json();
      return { payload, fetchedAt: Date.now(), fetchMs: Date.now() - started, url: url.toString() };
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") {
        throw new Error("Source timed out while loading analytics data.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });

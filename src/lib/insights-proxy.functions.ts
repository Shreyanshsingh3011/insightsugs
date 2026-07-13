import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";

const InputSchema = z.object({
  url: z.string().url().max(3000),
  // Optional Google Sheets tab name (e.g. "PSPCL", "NIT-58"). When the URL is
  // a Google Sheets link, this picks the worksheet. Falls back to gid in the
  // URL (#gid=...) and then to the first sheet.
  tab: z.string().max(200).optional(),
});

const GATEWAY = "https://connector-gateway.lovable.dev/google_sheets/v4";

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.some((c) => c.length)) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((c) => c.length)) rows.push(row);
  }
  return rows;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPublicGoogleSheetRows(parsed: { id: string; gid?: string }, warning?: string): Promise<{
  connector: string;
  data: Record<string, string>[];
  generated_at: string;
  warning?: string;
}> {
  const candidates = [
    `https://docs.google.com/spreadsheets/d/${parsed.id}/export?format=csv${parsed.gid ? `&gid=${parsed.gid}` : ""}`,
    `https://docs.google.com/spreadsheets/d/${parsed.id}/gviz/tq?tqx=out:csv${parsed.gid ? `&gid=${parsed.gid}` : ""}`,
  ];
  let lastErr = "";
  for (const url of candidates) {
    try {
      const res = await fetchWithTimeout(url, { headers: { Accept: "text/csv,*/*" }, redirect: "follow", cache: "no-store" }, 12_000);
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
      const values = parseCSV(await res.text());
      if (!values.length) { lastErr = "empty CSV"; continue; }
      const cols = values[0].map((h, i) => String(h || `Col${i + 1}`).trim());
      const rows = values.slice(1).map((r) => {
        const obj: Record<string, string> = {};
        cols.forEach((h, i) => (obj[h] = String(r[i] ?? "")));
        return obj;
      });
      return {
        connector: "Google Sheet — public CSV",
        data: rows,
        generated_at: new Date().toISOString(),
        warning,
      };
    } catch (error) {
      lastErr = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Google Sheets public CSV fallback failed: ${lastErr || "no data"}`);
}

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

function assertBearerPresent() {
  const authHeader = getRequestHeader("authorization");
  if (!authHeader?.startsWith("Bearer ") || !authHeader.slice("Bearer ".length).trim()) {
    throw new Error("Unauthorized: No authorization header provided");
  }
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
  const metaRes = await fetchWithTimeout(
    `${GATEWAY}/spreadsheets/${parsed.id}?fields=properties.title,sheets.properties(sheetId,title,index)`,
    { headers },
    12_000,
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
  // Prefer an explicit gid in the URL — it uniquely identifies a worksheet.
  // A generic tab hint (e.g. "Sheet1" from the master registry) would
  // otherwise collapse Bihar/Himachal/PSPCL onto the same first tab.
  if (parsed.gid) {
    const gid = Number(parsed.gid);
    chosen = sheets.find(s => s.properties.sheetId === gid)?.properties;
    if (!chosen) {
      tabFallbackReason = `gid=${gid} not found in "${meta.properties?.title ?? parsed.id}". Available tabs: ${available.map(t => `"${t}"`).join(", ")}.`;
      console.warn(`[insights-proxy] ${tabFallbackReason}`);
    }
  }
  if (!chosen && tabHint) {
    const needle = tabHint.trim().toLowerCase();
    chosen = sheets.find(s => s.properties.title.trim().toLowerCase() === needle)?.properties
      ?? sheets.find(s => s.properties.title.toLowerCase().includes(needle))?.properties;
    if (!chosen && !tabFallbackReason) {
      tabFallbackReason = `Tab "${tabHint}" not found in "${meta.properties?.title ?? parsed.id}". Available tabs: ${available.map(t => `"${t}"`).join(", ")}. Falling back to first tab.`;
      console.warn(`[insights-proxy] ${tabFallbackReason}`);
    }
  }
  if (!chosen) chosen = sheets[0].properties;

  const range = `${chosen.title}!A1:ZZ10000`;
  const valRes = await fetchWithTimeout(
    `${GATEWAY}/spreadsheets/${parsed.id}/values/${range}?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
    { headers },
    15_000,
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
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }) => {
    // This is a read-only source fetch used by the dashboard. Require a bearer
    // session header, but do not call the backend token validator here: during
    // schema-cache/auth outages it rejects otherwise usable sessions and blanks
    // the dashboard. State-changing/server-data functions still use the full
    // auth middleware.
    assertBearerPresent();
    const url = assertSafePublicUrl(data.url);
    const started = Date.now();

    // Google Sheets URL → read the public CSV export first. The provided
    // dashboard links are public and gid-specific; this path is the freshest
    // view and avoids connector/cache/tab mismatches.
    if (isGoogleSheetsUrl(url)) {
      const parsed = parseSheetsUrl(url);
      let payload: Awaited<ReturnType<typeof fetchPublicGoogleSheetRows>>;
      try {
        payload = await fetchPublicGoogleSheetRows(parsed);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`[insights-proxy] Google Sheets public CSV failed; trying connector fallback. ${msg}`);
        payload = await fetchGoogleSheetRows(url, data.tab);
        payload.warning = payload.warning ?? `Connector fallback used: ${msg}`;
      }
      return { payload, fetchedAt: Date.now(), fetchMs: Date.now() - started, url: url.toString() };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55_000);
    try {
      const freshUrl = new URL(url.toString());
      freshUrl.searchParams.set("_fresh", String(Date.now()));
      const res = await fetch(freshUrl.toString(), {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json", "Cache-Control": "no-cache", Pragma: "no-cache" },
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
      const isAbort = (error as { name?: string })?.name === "AbortError";
      const msg = isAbort
        ? "Source timed out while loading analytics data."
        : (error instanceof Error ? error.message : String(error));
      console.warn(`[insights-proxy] upstream fetch failed: ${msg}`);
      // Return degraded payload instead of throwing so UI doesn't blank-screen.
      return {
        payload: { rows: [], columns: [], warning: msg, degraded: true },
        fetchedAt: Date.now(),
        fetchMs: Date.now() - started,
        url: url.toString(),
        degraded: true,
      };
    } finally {
      clearTimeout(timer);
    }
  });

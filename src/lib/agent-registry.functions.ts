import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Master sheet that lists every project source. Each row should contain a
// human label and any URL — either a sheet2api endpoint or a Google Sheets
// link. New rows automatically appear on the Agent Dashboard.
const MASTER_SHEET_ID = "1N8JUhzKgLpxlCj61XUkLj85vDilpL0vartwfgxJGGpk";
const GATEWAY = "https://connector-gateway.lovable.dev/google_sheets/v4";

export type AgentProject = { id: string; label: string; url: string; tab?: string; note?: string };

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "src";
}

function extractUrl(cells: string[]): string | undefined {
  for (const c of cells) {
    const m = String(c || "").match(/https?:\/\/\S+/);
    if (m) return m[0].replace(/[),\s]+$/, "");
  }
  return undefined;
}

function idxByHeader(headers: string[], needles: string[]): number {
  return headers.findIndex(h => needles.some(n => h.toLowerCase().includes(n)));
}

function pickLabel(headers: string[], row: string[]): string {
  const labelIdx = idxByHeader(headers, ["project name", "project", "name", "label", "title", "site", "department"]);
  if (labelIdx >= 0 && row[labelIdx]) return String(row[labelIdx]).trim();
  // fallback: first non-URL, non-empty cell
  for (const c of row) {
    const s = String(c || "").trim();
    if (s && !/^https?:\/\//i.test(s)) return s;
  }
  return "";
}

function pickTab(headers: string[], row: string[]): string | undefined {
  // Prefer an explicit tab/worksheet column. "Sheet Link" often holds the URL
  // now, so match "sheetname" / "worksheet" / "tab" instead.
  const idx = idxByHeader(headers, ["sheetname", "sheet name", "worksheet", "tab"]);
  if (idx < 0) return undefined;
  const v = String(row[idx] ?? "").trim();
  return v || undefined;
}

// Minimal CSV parser (handles quoted fields with commas / escaped quotes / CRLF).
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQ = false; }
      } else field += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some(c => c.length)) rows.push(row);
        row = [];
      } else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); if (row.some(c => c.length)) rows.push(row); }
  return rows;
}

function buildProjects(values: string[][]): AgentProject[] {
  if (values.length < 2) return [];
  const hdrs = values[0].map(h => String(h || "").trim());
  const seen = new Set<string>();
  const projects: AgentProject[] = [];
  for (const row of values.slice(1)) {
    if (!row || row.every(c => !String(c || "").trim())) continue;
    const url = extractUrl(row);
    if (!url) continue;
    const label = pickLabel(hdrs, row) || `Project ${projects.length + 1}`;
    const tab = pickTab(hdrs, row);
    let id = slug(label);
    let n = 2;
    while (seen.has(id)) id = `${slug(label)}-${n++}`;
    seen.add(id);
    projects.push({ id, label, url, tab });
  }
  return projects;
}

// Public fallback — works when the sheet is shared "Anyone with the link" and
// the Google Sheets connector is unavailable or lacks access.
async function fetchPublicCSV(): Promise<string[][]> {
  const urls = [
    `https://docs.google.com/spreadsheets/d/${MASTER_SHEET_ID}/gviz/tq?tqx=out:csv`,
    `https://docs.google.com/spreadsheets/d/${MASTER_SHEET_ID}/export?format=csv`,
  ];
  let lastErr = "";
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { Accept: "text/csv,*/*" }, redirect: "follow" });
      if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
      const t = await r.text();
      if (t.trim().length) return parseCSV(t);
    } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
  }
  throw new Error(`Public sheet unreachable: ${lastErr || "no data"}`);
}

// Built-in fallback — kept in sync with AgentDashboard.FALLBACK_PROJECTS and
// useAgentSources.FALLBACK_PROJECTS. Used when the master sheet is empty or
// unreachable so watchers/cron still have something to scan.
export const FALLBACK_PROJECTS: AgentProject[] = [
  { id: "nit58", label: "NIT-58",        url: "https://sheet2api-bypassed-login.vercel.app/api/public/a02c5f0800319fabb6d0679ec385de83" },
  { id: "bihar", label: "Bihar",         url: "https://docs.google.com/spreadsheets/d/1ZQ56Y0nWMO28RQnWB1nQrjqNfFUuh8tIPw2k48eXEzQ/edit?gid=1685983370#gid=1685983370" },
  { id: "hp",    label: "Himachal",      url: "https://docs.google.com/spreadsheets/d/1ZQ56Y0nWMO28RQnWB1nQrjqNfFUuh8tIPw2k48eXEzQ/edit?gid=1063989895#gid=1063989895" },
  { id: "pspcl", label: "PSPCL",         url: "https://docs.google.com/spreadsheets/d/1ZQ56Y0nWMO28RQnWB1nQrjqNfFUuh8tIPw2k48eXEzQ/edit?gid=318275095#gid=318275095" },
  { id: "nit76", label: "NIT-76",        url: "https://sheet2api-bypassed-login.vercel.app/api/public/f81e454c36f9c0c609d103ba99e950b4" },
];

// Pure server-side helper — safe to import from other server code
// (webhooks, cron endpoints) that doesn't have a Supabase auth context.
export async function loadAgentProjects(): Promise<{ projects: AgentProject[]; source: string; fetched_at: string }> {
  const lovable = process.env.LOVABLE_API_KEY;
  const key = process.env.GOOGLE_SHEETS_API_KEY;
  const now = () => new Date().toISOString();

  if (lovable && key) {
    try {
      const headers = {
        Authorization: `Bearer ${lovable}`,
        "X-Connection-Api-Key": key,
        Accept: "application/json",
      };
      const metaRes = await fetch(
        `${GATEWAY}/spreadsheets/${MASTER_SHEET_ID}?fields=properties.title,sheets.properties(sheetId,title,index)`,
        { headers },
      );
      if (metaRes.ok) {
        const meta = (await metaRes.json()) as {
          sheets?: { properties: { sheetId: number; title: string; index: number } }[];
        };
        const first = meta.sheets?.sort((a, b) => a.properties.index - b.properties.index)[0];
        const tab = first?.properties.title ?? "Sheet1";
        const valRes = await fetch(
          `${GATEWAY}/spreadsheets/${MASTER_SHEET_ID}/values/${tab}!A1:Z500?valueRenderOption=FORMATTED_VALUE`,
          { headers },
        );
        if (valRes.ok) {
          const vjson = (await valRes.json()) as { values?: string[][] };
          const projects = buildProjects(vjson.values ?? []);
          if (projects.length) return { projects, source: `gateway:${tab}`, fetched_at: now() };
        }
      }
    } catch { /* fall through */ }
  }
  try {
    const values = await fetchPublicCSV();
    const projects = buildProjects(values);
    if (projects.length) return { projects, source: "public-csv", fetched_at: now() };
  } catch { /* fall through to built-in fallback */ }
  return { projects: FALLBACK_PROJECTS, source: "fallback:builtin", fetched_at: now() };
}


export const fetchAgentProjects = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => loadAgentProjects());


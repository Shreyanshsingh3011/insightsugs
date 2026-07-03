import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Master sheet that lists every project source. Each row should contain a
// human label and any URL — either a sheet2api endpoint or a Google Sheets
// link. New rows automatically appear on the Agent Dashboard.
const MASTER_SHEET_ID = "1N8JUhzKgLpxlCj61XUkLj85vDilpL0vartwfgxJGGpk";
const GATEWAY = "https://connector-gateway.lovable.dev/google_sheets/v4";

export type AgentProject = { id: string; label: string; url: string; note?: string };

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

function pickLabel(headers: string[], row: string[]): string {
  const idxByHeader = (needles: string[]) =>
    headers.findIndex(h => needles.some(n => h.toLowerCase().includes(n)));
  const labelIdx = idxByHeader(["name", "project", "label", "title", "site", "department"]);
  if (labelIdx >= 0 && row[labelIdx]) return String(row[labelIdx]).trim();
  // fallback: first non-URL, non-empty cell
  for (const c of row) {
    const s = String(c || "").trim();
    if (s && !/^https?:\/\//i.test(s)) return s;
  }
  return "";
}

export const fetchAgentProjects = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ projects: AgentProject[]; source: string; fetched_at: string }> => {
    const lovable = process.env.LOVABLE_API_KEY;
    const key = process.env.GOOGLE_SHEETS_API_KEY;
    if (!lovable || !key) throw new Error("Google Sheets connector not configured.");

    const headers = {
      Authorization: `Bearer ${lovable}`,
      "X-Connection-Api-Key": key,
      Accept: "application/json",
    };

    // Discover first tab
    const metaRes = await fetch(
      `${GATEWAY}/spreadsheets/${MASTER_SHEET_ID}?fields=properties.title,sheets.properties(sheetId,title,index)`,
      { headers },
    );
    if (!metaRes.ok) {
      const body = await metaRes.text().catch(() => "");
      throw new Error(`Master sheet HTTP ${metaRes.status}: ${body.slice(0, 200)}`);
    }
    const meta = (await metaRes.json()) as {
      sheets?: { properties: { sheetId: number; title: string; index: number } }[];
    };
    const first = meta.sheets?.sort((a, b) => a.properties.index - b.properties.index)[0];
    const tab = first?.properties.title ?? "Sheet1";

    const valRes = await fetch(
      `${GATEWAY}/spreadsheets/${MASTER_SHEET_ID}/values/${tab}!A1:Z500?valueRenderOption=FORMATTED_VALUE`,
      { headers },
    );
    if (!valRes.ok) {
      const body = await valRes.text().catch(() => "");
      throw new Error(`Master sheet values HTTP ${valRes.status}: ${body.slice(0, 200)}`);
    }
    const vjson = (await valRes.json()) as { values?: string[][] };
    const values = vjson.values ?? [];
    if (values.length < 2) return { projects: [], source: tab, fetched_at: new Date().toISOString() };

    const hdrs = values[0].map(h => String(h || "").trim());
    const seen = new Set<string>();
    const projects: AgentProject[] = [];

    for (const row of values.slice(1)) {
      if (!row || row.every(c => !String(c || "").trim())) continue;
      const url = extractUrl(row);
      if (!url) continue;
      const label = pickLabel(hdrs, row) || `Project ${projects.length + 1}`;
      let id = slug(label);
      let n = 2;
      while (seen.has(id)) id = `${slug(label)}-${n++}`;
      seen.add(id);
      projects.push({ id, label, url });
    }

    return { projects, source: tab, fetched_at: new Date().toISOString() };
  });

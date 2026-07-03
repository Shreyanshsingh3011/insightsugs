import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const InputSchema = z.object({
  spreadsheetId: z.string().min(10).max(200),
  sheetName: z.string().min(1).max(200).optional(),
  range: z.string().max(200).optional(),
});

const GATEWAY = "https://connector-gateway.lovable.dev/google_sheets/v4";

function parseSpreadsheetInput(raw: string): { id: string; gid?: string } {
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const id = m ? m[1] : raw;
  const gidMatch = raw.match(/[#?&]gid=(\d+)/);
  return { id, gid: gidMatch?.[1] };
}

export const fetchSheetRows = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data }) => {
    const lovable = process.env.LOVABLE_API_KEY;
    const key = process.env.GOOGLE_SHEETS_API_KEY;
    if (!lovable || !key) throw new Error("Google Sheets connector not configured.");

    const parsed = parseSpreadsheetInput(data.spreadsheetId);
    const authHeaders = {
      Authorization: `Bearer ${lovable}`,
      "X-Connection-Api-Key": key,
      Accept: "application/json",
    };

    // Discover sheet name if not provided
    let sheetName = data.sheetName;
    let title: string | undefined;
    if (!sheetName) {
      const metaRes = await fetch(
        `${GATEWAY}/spreadsheets/${parsed.id}?fields=properties.title,sheets.properties(sheetId,title)`,
        { headers: authHeaders },
      );
      if (!metaRes.ok) throw new Error(`Sheet metadata HTTP ${metaRes.status}`);
      const meta = (await metaRes.json()) as {
        properties?: { title?: string };
        sheets?: { properties: { sheetId: number; title: string } }[];
      };
      title = meta.properties?.title;
      const gid = parsed.gid ? Number(parsed.gid) : undefined;
      const picked =
        (gid !== undefined && meta.sheets?.find(s => s.properties.sheetId === gid)) ||
        meta.sheets?.[0];
      sheetName = picked?.properties.title ?? "Sheet1";
    }

    const range = data.range ?? `${sheetName}!A1:ZZ10000`;
    const valRes = await fetch(
      `${GATEWAY}/spreadsheets/${parsed.id}/values/${range}?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
      { headers: authHeaders },
    );
    if (!valRes.ok) throw new Error(`Sheet values HTTP ${valRes.status}`);
    const vjson = (await valRes.json()) as { values?: string[][] };
    const values = vjson.values ?? [];
    if (values.length === 0) {
      return { title, sheetName, columns: [], rows: [] as Record<string, string>[] };
    }
    const headers = values[0].map((h, i) => String(h || `Col${i + 1}`).trim());
    const rows: Record<string, string>[] = values.slice(1).map(r => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => (obj[h] = String(r[i] ?? "")));
      return obj;
    });
    return { title, sheetName, columns: headers, rows };
  });

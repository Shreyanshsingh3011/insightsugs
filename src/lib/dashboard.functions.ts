import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type {
  DashboardData,
  PersonEntry,
  DeptEntry,
  TatRow,
  FlagEntry,
} from "@/lib/dashboard-data";
import { resolvePerson, type ProfileDirectory } from "@/lib/person-resolver";
import { isTerminalRow, rowStatusText, sanitizeDuration, statusBucket } from "@/lib/status-utils";


type Row = Record<string, string>;

// Normalize a status string into one of our display buckets.
function bucketStatus(raw: string): string {
  const v = (raw || "").trim();
  if (!v) return "Unknown";
  const terminalAware = statusBucket(v);
  if (terminalAware !== "Other") return terminalAware === "Not Started" ? "Yet to Start" : terminalAware;
  const lower = v.toLowerCase();
  if (/(block|hold|stuck|stop)/.test(lower)) return "Blocked";
  if (/(delay|late|overdue|breach|pending|due)/.test(lower)) return "Delayed";
  if (/(not start|yet to|todo|planned|scheduled)/.test(lower)) return "Yet to Start";
  return raw;
}

function parseDate(s: string): Date | null {
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t);
  // dd/mm/yyyy or dd-mm-yyyy
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const [, d, mo, y] = m;
    const yr = y.length === 2 ? 2000 + Number(y) : Number(y);
    const dt = new Date(yr, Number(mo) - 1, Number(d));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  return null;
}

function num(v: string): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

interface NormalizedRow {
  sheetName: string;
  sheetType: string;
  row: Row;
  status: string;
  isDelayed: boolean;
  isCompleted: boolean;
  isBlocked: boolean;
  overdue: number;
  owner?: string;
  ownerEmail?: string;
  ownerKey?: string;
  ownerSource?: string;
  ownerIsTitleFallback?: boolean;
  dept?: string;
  activity?: string;
  reason?: string;
  tat?: number;
  daysTaken?: number;
}


function normalizeRow(
  sheetName: string,
  sheetType: string,
  merged: Row,
  directory?: ProfileDirectory,
): NormalizedRow {

  const now = new Date();
  const status = isTerminalRow(merged) ? "Completed" : bucketStatus(rowStatusText(merged) || merged.status || merged.breach || "");
  const isCompleted = status === "Completed";
  const isBlocked = status === "Blocked";

  const plannedEnd = parseDate(merged.planned_end || merged.due_date || merged.expected_date || "");
  const actualEnd = parseDate(merged.actual_end || merged.completion_date || merged.received_date || merged.paid_date || "");
  const startDate = parseDate(merged.actual_start || merged.planned_start || merged.start_date || merged.po_date || merged.bill_date || merged.received_date || "");

  let overdue = 0;
  // Sanitize TAT / Days-Taken at the feed boundary so serial-date leaks and
  // multi-year junk values never reach the KPI aggregations.
  const sanitize = (v: number | undefined) => v === undefined ? undefined : (sanitizeDuration(v) || undefined);
  let tat = sanitize(num(merged.sla_days) ?? num(merged.tat_days));
  let daysTaken = sanitize(num(merged.tat_days));

  if (startDate && actualEnd) daysTaken = sanitize(daysBetween(startDate, actualEnd));
  if (startDate && plannedEnd && tat === undefined) tat = sanitize(daysBetween(startDate, plannedEnd));

  if (isCompleted && plannedEnd && actualEnd) {
    overdue = Math.max(0, daysBetween(plannedEnd, actualEnd));
  } else if (!isCompleted && plannedEnd) {
    overdue = Math.max(0, daysBetween(plannedEnd, now));
  }

  const breachFlag = /^(true|yes|1|breach|y)$/i.test(merged.breach || "");
  const isDelayed = !isCompleted && (status === "Delayed" || overdue > 0 || breachFlag);

  // Resolve the row's person using the shared resolver (title → name mapping).
  const rawRole =
    merged.responsible_person ||
    merged.responsibility ||
    merged.approvers_name ||
    merged.owner ||
    merged.approver ||
    merged.vendor ||
    merged.contractor ||
    "";
  const altName =
    merged.owner_name || merged.assignee || merged.assigned_to || "";
  const email = (
    merged.responsible_person_mail_id ||
    merged.approvers_email_id ||
    merged.owner_email ||
    ""
  ).toLowerCase();
  const resolution = resolvePerson(
    { raw: rawRole, alt: altName, email },
    directory,
  );
  const ownerLabel = resolution.displayName && resolution.source !== "unassigned"
    ? resolution.displayName
    : undefined;

  return {
    sheetName,
    sheetType,
    row: merged,
    status: isDelayed && status !== "Blocked" ? "Delayed" : status,
    isDelayed,
    isCompleted,
    isBlocked,
    overdue,
    owner: ownerLabel,
    ownerEmail: resolution.email || undefined,
    ownerKey: resolution.key,
    ownerSource: resolution.source,
    ownerIsTitleFallback: resolution.isTitleFallback,
    dept: merged.dept || merged.department || undefined,
    activity: merged.activity || merged.item || merged.material || merged.kpi || merged.bill_no || merged.po_no || undefined,
    reason: (merged.remarks || merged.reason || "").trim() || undefined,
    tat,
    daysTaken,

  };
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const buildDashboardFromSheets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({ sheetIds: z.array(z.string().min(1)).min(1).max(20) })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<DashboardData> => {
    const { supabase, userId } = context;

    // Callers may pass registry UUIDs OR slug ids (e.g. "nit58") from
    // FALLBACK_PROJECTS. Only UUIDs are valid keys for sheet_registry.id.
    const uuidIds = data.sheetIds.filter((id) => UUID_RE.test(id));
    if (uuidIds.length === 0) throw new Error("No registered sheets found for this user.");

    const { data: regs, error: regErr } = await supabase
      .from("sheet_registry")
      .select("id, display_name, sheet_type")
      .in("id", uuidIds)
      .eq("user_id", userId);
    if (regErr) throw new Error(regErr.message);
    if (!regs || regs.length === 0) throw new Error("No matching sheets.");

    // Fetch the profile directory once so we can map Responsible-Person-Mail-ID
    // → profiles.full_name and avoid job-title fallbacks.
    const directory: ProfileDirectory = new Map();
    try {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("email, full_name");
      for (const p of profiles ?? []) {
        const em = String(p.email ?? "").trim().toLowerCase();
        const nm = String(p.full_name ?? "").trim();
        if (em && nm) directory.set(em, nm);
      }
    } catch {
      // non-fatal: resolver falls back to email-local / raw values.
    }

    const PER_SHEET = 1000;
    const normalized: NormalizedRow[] = [];
    const sheetsMeta: { label: string; name: string; rows: number; columns: number }[] = [];

    // Single round-trip: fetch rows for ALL requested sheets in one query,
    // then group in memory. Replaces the previous per-sheet N+1 loop.
    const regById = new Map(regs.map((r) => [r.id, r]));
    const { data: allRows, error: rowsErr } = await supabase
      .from("sheet_rows")
      .select("sheet_registry_id, canonical, extras")
      .in("sheet_registry_id", regs.map((r) => r.id))
      .order("sheet_registry_id", { ascending: true })
      .order("row_index", { ascending: true });
    if (rowsErr) throw new Error(rowsErr.message);

    const perSheetCounts = new Map<string, number>();
    for (const row of (allRows ?? []) as Array<{ sheet_registry_id: string; canonical: unknown; extras: unknown }>) {
      const r = regById.get(row.sheet_registry_id);
      if (!r) continue;
      const used = perSheetCounts.get(r.id) ?? 0;
      if (used >= PER_SHEET) continue;
      perSheetCounts.set(r.id, used + 1);
      const merged: Row = {};
      for (const [k, v] of Object.entries((row.canonical as Record<string, unknown>) ?? {})) merged[k] = String(v ?? "");
      for (const [k, v] of Object.entries((row.extras as Record<string, unknown>) ?? {})) {
        const key = k.toLowerCase().replace(/\s+/g, "_");
        if (!(key in merged)) merged[key] = String(v ?? "");
      }
      normalized.push(normalizeRow(r.display_name, r.sheet_type, merged, directory));
    }
    for (const r of regs) {
      sheetsMeta.push({
        label: r.sheet_type,
        name: r.display_name,
        rows: perSheetCounts.get(r.id) ?? 0,
        columns: 0,
      });
    }


    // Aggregates
    const status_breakdown: Record<string, number> = {};
    const reasonAgg: Record<string, { count: number; days: number }> = {};
    const personMap = new Map<string, PersonEntry>();
    const deptMap = new Map<string, DeptEntry>();
    const tatRows: TatRow[] = [];
    const flags: FlagEntry[] = [];

    let delayed = 0, completed = 0, blocked = 0, at_risk = 0;
    let flagSeq = 1;

    for (const n of normalized) {
      status_breakdown[n.status] = (status_breakdown[n.status] || 0) + 1;
      if (n.isCompleted) completed += 1;
      if (n.isBlocked) blocked += 1;
      if (n.isDelayed) delayed += 1;
      if (!n.isCompleted && n.overdue > 0) at_risk += 1;

      if (n.isDelayed) {
        const reason = n.reason || "Unspecified";
        if (!reasonAgg[reason]) reasonAgg[reason] = { count: 0, days: 0 };
        reasonAgg[reason].count += 1;
        reasonAgg[reason].days += n.overdue;

        if (n.owner) {
          const key = n.ownerKey || n.owner;
          const p = personMap.get(key) ?? {
            person: n.owner, email: n.ownerEmail ?? "", phone: "",
            delay_count: 0, total_overdue_days: 0, reasons: {}, activities: [],
          };
          p.delay_count += 1;
          p.total_overdue_days += n.overdue;
          if (!p.email && n.ownerEmail) p.email = n.ownerEmail;
          p.reasons[reason] = (p.reasons[reason] || 0) + 1;
          if (n.activity && !p.activities.includes(n.activity)) p.activities.push(n.activity);
          personMap.set(key, p);
        }

        if (n.dept) {
          const d = deptMap.get(n.dept) ?? {
            department: n.dept, delay_count: 0, total_overdue_days: 0, reasons: {},
          };
          d.delay_count += 1;
          d.total_overdue_days += n.overdue;
          d.reasons[reason] = (d.reasons[reason] || 0) + 1;
          deptMap.set(n.dept, d);
        }

        // Skip phantom flags: rows with no identifiable activity, owner, or
        // department are unusable — the user cannot trace the source. Also
        // skip "not started" rows (no work booked) unless the sheet text
        // explicitly labels them delayed.
        const hasIdentity = !!(n.activity || n.owner || n.dept);
        const notStartedNoSignal = (!n.daysTaken || n.daysTaken === 0) && n.overdue === 0;
        if (!hasIdentity || notStartedNoSignal) continue;

        const severity = n.overdue >= 15 ? "Critical" : n.overdue >= 7 ? "High" : n.overdue >= 3 ? "Medium" : "Low";
        flags.push({
          id: `F-${String(flagSeq++).padStart(4, "0")}`,
          activity: n.activity ?? "(unnamed)",
          flagged_to: n.owner ? { person: n.owner } : undefined,
          reason: n.reason,
          reason_text: n.reason,
          tat: n.tat ?? null,
          days_taken: n.daysTaken ?? null,
          overdue_days: n.overdue,
          severity,
          status: n.status,
          stage: n.sheetType,
          source: n.sheetName,
          escalation_level: n.overdue >= 15 ? 2 : n.overdue >= 7 ? 1 : 0,
        });
      }

      if (n.tat && n.daysTaken && n.activity) {
        const delta = n.daysTaken - n.tat;
        tatRows.push({
          activity: n.activity,
          tat: n.tat,
          days_taken: n.daysTaken,
          delta,
          overrun_pct: n.tat ? (delta / n.tat) * 100 : 0,
          status: n.status,
          person: n.owner ?? "—",
        });
      }
    }

    const top_delay_reasons = Object.entries(reasonAgg)
      .map(([reason, v]) => ({ reason, count: v.count, total_overdue_days: v.days }))
      .sort((a, b) => b.count - a.count);

    const person_ranking = [...personMap.values()].sort((a, b) => b.total_overdue_days - a.total_overdue_days);
    const department_ranking = [...deptMap.values()].sort((a, b) => b.total_overdue_days - a.total_overdue_days);
    tatRows.sort((a, b) => b.overrun_pct - a.overrun_pct);
    flags.sort((a, b) => (b.overdue_days ?? 0) - (a.overdue_days ?? 0));

    const totalRows = normalized.length;
    const risk_score = totalRows > 0
      ? Math.min(100, Math.round((delayed / totalRows) * 100 + Math.min(30, at_risk)))
      : 0;

    const summary = `${totalRows} rows analysed across ${regs.length} sheet${regs.length === 1 ? "" : "s"}. ${delayed} delayed. ${blocked} blocked.`;

    return {
      summary,
      totals: { rows: totalRows, delayed, blocked, completed, at_risk },
      risk_score,
      status_breakdown,
      top_delay_reasons,
      person_ranking,
      department_ranking,
      tat_performance: { rows: tatRows },
      flags,
      mode_badge: "Live · Multi-sheet",
      sheets: sheetsMeta,
    };
  });

export const listMyRegistryIds = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<string[]> => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("sheet_registry")
      .select("id")
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => r.id as string);
  });

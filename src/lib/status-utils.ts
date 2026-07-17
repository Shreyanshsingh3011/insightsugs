export type StatusRow = Record<string, unknown>;

export type StatusBucket = "Completed" | "In Progress" | "Delayed" | "Not Started" | "Other";

const STATUS_ALIASES = [
  "Status Category",
  "Status as on Date",
  "Status",
  "Current Status",
  "Activity Status",
  "Task Status",
  "Progress Status",
  "Completion Status",
  "Work Status",
  "Stage Status",
  "status",
  "current_status",
  "activity_status",
  "task_status",
  "progress_status",
  "completion_status",
  "work_status",
  "stage_status",
  "breach",
];

const COMPLETION_ALIASES = [
  "Completion Date",
  "Completion Date Updated by Project Team",
  "Completion Date Verified by VHs",
  "Completion Date Verified by VH",
  "Completed Date",
  "Date of Completion",
  "Actual Completion Date",
  "Actual Date",
  "Actual",
  "Actual End",
  "Actual End Date",
  "Actual Finish",
  "Actual Finish Date",
  "Finish Date",
  "Finished Date",
  "Closed Date",
  "Closure Date",
  "Completed On",
  "Done On",
  "Received Date",
  "Received On",
  "Paid Date",
  "Paid On",
  "Delivered Date",
  "Dispatch Date",
  "Dispatched Date",
  "Approval Date",
  "Approved Date",
  "Approved On",
  "Signed On",
  "Sign Off Date",
  "completion_date",
  "completion_date_updated_by_project_team",
  "completion_date_verified_by_vhs",
  "completed_date",
  "actual_completion_date",
  "actual_date",
  "actual_end",
  "actual_end_date",
  "actual_finish",
  "finish_date",
  "finished_date",
  "closed_date",
  "closure_date",
  "completed_on",
  "done_on",
  "received_date",
  "paid_date",
  "delivered_date",
  "dispatch_date",
  "approval_date",
  "approved_date",
];

const START_ALIASES = [
  "Start Date", "Start", "Started On", "Start On", "Actual Start", "Actual Start Date",
  "Planned Start", "Planned Start Date", "Kickoff Date", "Kick-off Date",
  "start_date", "start", "started_on", "actual_start", "actual_start_date",
  "planned_start", "planned_start_date",
];


function normKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function valueForAliases(row: StatusRow, aliases: string[]): string {
  for (const key of aliases) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  const wanted = new Set(aliases.map(normKey));
  for (const [key, value] of Object.entries(row)) {
    if (!wanted.has(normKey(key))) continue;
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

// Parse a cell value into a Date. Supports Excel/Sheets date serials,
// ISO strings, and common dd/mm/yyyy or mm/dd/yyyy formats.
function parseDateCell(raw: unknown): Date | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const num = Number(s.replace(/[,\s]/g, ""));
  if (Number.isFinite(num) && num >= 20000 && num <= 80000) {
    const ms = Math.round((num - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d;
  }
  const iso = Date.parse(s);
  if (Number.isFinite(iso) && iso > 0) return new Date(iso);
  const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (m) {
    const day = Number(m[1]), month = Number(m[2]);
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const d = new Date(Date.UTC(year, month - 1, day));
      if (!isNaN(d.getTime())) return d;
    }
  }
  return null;
}

// Recompute "Days Taken" authoritatively from Start + Completion dates.
// The sheet's own Days Taken column is unreliable (frequently TODAY()-Start
// even after completion, or =DAY() of a date). When Start exists we use
// End-Start (completed) or Today-Start (in progress); otherwise null.
export function recomputeDaysTaken(row: StatusRow): number | null {
  const start = parseDateCell(valueForAliases(row, START_ALIASES));
  if (!start) return null;
  const end = parseDateCell(valueForAliases(row, COMPLETION_ALIASES));
  const ref = end ?? new Date();
  const diff = Math.floor((ref.getTime() - start.getTime()) / 86400000);
  if (!Number.isFinite(diff) || diff < 0 || diff > 3650) return null;
  return diff;
}


export function isTerminalStatusText(raw: unknown): boolean {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return false;
  if (/\b(not\s+complete|not\s+completed|not\s+done|incomplete|pending\s+completion|under\s+progress|in\s+progress)\b/.test(value)) return false;
  return /\b(completed?|complet|done|closed?|finished?|resolved|fulfilled|cancelled|canceled|dropped|withdrawn|received|paid|approved|signed|delivered|dispatched|executed|issued|released|handover|handed\s*over|ok|yes)\b/.test(value);
}

function isMeaningfulCompletionValue(raw: unknown): boolean {
  const value = String(raw ?? "").trim();
  if (!value) return false;
  const lower = value.toLowerCase();
  if (/^(no|false|0|n|na|n\/a|null|none|-|—|pending|open|not\s+done|not\s+complete|not\s+completed|in\s+progress|under\s+progress)$/i.test(lower)) return false;
  if (/\b1900\b/.test(lower) || /\b1899\b/.test(lower)) return false;
  if (isTerminalStatusText(value)) return true;
  if (/^date\(/i.test(value)) return true;
  if (/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(value)) return true;
  if (/\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b/.test(value)) return true;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function hasCompletionDateSerialInDurationColumn(row: StatusRow): boolean {
  const candidates = [
    valueForAliases(row, ["Days Taken", "days_taken", "Days taken"]),
    valueForAliases(row, ["Delay in Days", "delay_in_days", "Delay Days", "Delay (Days)", "Delay"]),
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const value = Number(String(raw).replace(/[,\s]/g, ""));
    // Excel/Sheets date serials around current years are ~45k. If that appears
    // in a duration column, the row has effectively recorded an actual date and
    // should not stay in overdue/next-action lists.
    if (Number.isFinite(value) && value >= 30000 && value <= 70000) return true;
  }
  return false;
}


// Generic detection: any column whose name looks like a completion/actual/closed
// date column and holds a meaningful date value implies the row is done.
// This catches sheet-specific columns not in COMPLETION_ALIASES.
function hasAnyCompletionDateColumn(row: StatusRow): boolean {
  const pattern = /(completion|completed|complete\s*date|actual(\s|_)*(date|end|finish|completion)?|finish(ed)?\s*date|closed?\s*(date|on)|closure|delivered|dispatch(ed)?|received|paid|approv(al|ed)|signed?\s*(off|on)|handover|handed\s*over|done\s*on)/i;
  for (const [key, value] of Object.entries(row)) {
    if (!pattern.test(key)) continue;
    if (isMeaningfulCompletionValue(value)) return true;
    // Numeric date serials (Excel) counted as completion too
    const num = Number(String(value ?? "").replace(/[,\s]/g, ""));
    if (Number.isFinite(num) && num >= 30000 && num <= 70000) return true;
  }
  return false;
}

function statusTextExplicitlyActive(row: StatusRow): boolean {
  // Trust the sheet's Status column when it explicitly reports an active /
  // non-terminal state. Otherwise a stray completion-date column (or a leaked
  // Excel date serial in a duration column) silently promotes the row to
  // Completed and it leaks into the Completed filter with an "In Progress"
  // pill — the exact bug users hit on the Bihar report.
  for (const key of STATUS_ALIASES) {
    const value = String(row[key] ?? "").trim().toLowerCase();
    if (!value) continue;
    if (/\b(in\s*progress|under\s*progress|ongoing|wip|active|working|delay|delayed|late|overdue|breach|slipp|pending|open|not\s*(complete|completed|done|started?)|yet\s*to)\b/.test(value)) return true;
  }
  const normalizedStatusKeys = new Set(STATUS_ALIASES.map(normKey));
  for (const [key, value] of Object.entries(row)) {
    if (!normalizedStatusKeys.has(normKey(key))) continue;
    const text = String(value ?? "").trim().toLowerCase();
    if (!text) continue;
    if (/\b(in\s*progress|under\s*progress|ongoing|wip|active|working|delay|delayed|late|overdue|breach|slipp|pending|open|not\s*(complete|completed|done|started?)|yet\s*to)\b/.test(text)) return true;
  }
  return false;
}

export function isTerminalRow(row: StatusRow): boolean {
  for (const key of STATUS_ALIASES) {
    if (isTerminalStatusText(row[key])) return true;
  }
  const normalizedStatusKeys = new Set(STATUS_ALIASES.map(normKey));
  for (const [key, value] of Object.entries(row)) {
    if (normalizedStatusKeys.has(normKey(key)) && isTerminalStatusText(value)) return true;
  }
  // % Complete / Progress = 100 counts as done.
  for (const [key, value] of Object.entries(row)) {
    const nk = normKey(key);
    if (nk === "complete" || nk === "percentcomplete" || nk === "complete" || nk === "progress" || nk === "progresspercent" || nk === "percentageofcompletion" || nk === "percentagecomplete" || nk.endsWith("complete") && nk.startsWith("percent")) {
      const num = Number(String(value ?? "").replace(/[%\s,]/g, ""));
      if (Number.isFinite(num) && num >= 100) return true;
    }
  }
  // Secondary heuristics (date columns / date-serial leaks) only apply when
  // the sheet's Status column is silent or already terminal — never override
  // an explicit "In Progress / Delayed / Pending" label.
  if (statusTextExplicitlyActive(row)) return false;
  const completion = valueForAliases(row, COMPLETION_ALIASES);
  return isMeaningfulCompletionValue(completion)
    || hasCompletionDateSerialInDurationColumn(row)
    || hasAnyCompletionDateColumn(row);
}



export function rowStatusText(row: StatusRow): string {
  for (const key of STATUS_ALIASES) {
    const value = String(row[key] ?? "").trim();
    if (isTerminalStatusText(value)) return value;
  }
  const normalizedStatusKeys = new Set(STATUS_ALIASES.map(normKey));
  for (const [key, value] of Object.entries(row)) {
    const text = String(value ?? "").trim();
    if (normalizedStatusKeys.has(normKey(key)) && isTerminalStatusText(text)) return text;
  }
  const completion = valueForAliases(row, COMPLETION_ALIASES);
  if (isMeaningfulCompletionValue(completion)) return "Completed";
  return valueForAliases(row, STATUS_ALIASES);
}

export function statusBucket(raw: unknown): StatusBucket {
  const value = String(raw ?? "").toLowerCase().trim();
  if (isTerminalStatusText(value)) return "Completed";
  if (/progress|ongoing|wip|active|working/.test(value)) return "In Progress";
  if (/delay|overdue|late|breach|slipp/.test(value)) return "Delayed";
  if (/not\s*start|yet\s*to|pending|new|open|awaiting|queued/.test(value)) return "Not Started";
  return "Other";
}

export function statusBucketForRow(row: StatusRow): StatusBucket {
  if (isTerminalRow(row)) return "Completed";
  return statusBucket(rowStatusText(row));
}

// Mirrors AgentDashboard's `effectivelyDone` heuristic so other surfaces
// (Agent Inbox, watchers, etc.) can filter to the same live-actionable rows.
export function isRowEffectivelyDone(row: StatusRow): boolean {
  if (isTerminalRow(row)) return true;
  // If the row's status text explicitly reports an active delay/overdue,
  // never silently mark it complete — sheet formulas often leak date serials
  // into "Delay in Days" for rows that are genuinely late. Trust the human
  // status over the numeric leak.
  const statusText = rowStatusText(row).toLowerCase();
  const explicitlyDelayed = /(delay|late|overdue|breach|slipp|pending|open|in\s*progress|not\s*(complete|done|start))/i.test(statusText);
  const toNum = (v: unknown) => {
    if (typeof v === "number") return v;
    const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };
  const isSerial = (n: number) => n >= 30000 && n <= 70000;
  if (!explicitlyDelayed) {
    // Excel date serials leaked into duration/delay columns = completion date recorded.
    if (isSerial(toNum(row["Days Taken"]))) return true;
    if (isSerial(toNum(row["Delay in Days"]))) return true;
  }
  const tat = toNum(row["TAT"]);
  const recomputed = recomputeDaysTaken(row);
  const rawTaken = recomputed ?? toNum(row["Days Taken"]);
  const taken = rawTaken > 3650 || rawTaken < 0 ? 0 : rawTaken;

  if (taken > 0 && tat > 0 && taken <= tat) return true;
  return false;
}

// Sanitized delay value for UI display and aggregation. Prefers explicit
// numeric "Delay in Days" when it's a real duration, otherwise falls back
// to the number parsed from the status text ("Delay by 59 days").
export function sanitizedDelayDays(row: StatusRow): number {
  const toNum = (v: unknown) => {
    if (typeof v === "number") return v;
    const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };
  const raw = toNum(row["Delay in Days"]);
  const explicit = raw > 3650 || raw < 0 || (raw >= 30000 && raw <= 70000) ? 0 : raw;
  if (explicit > 0) return Math.round(explicit);
  const status = rowStatusText(row);
  const m = status.match(/(?:delay(?:ed)?|late|overdue)\s*(?:by)?\s*(\d+(?:\.\d+)?)/i)
    || status.match(/(\d+(?:\.\d+)?)\s*(?:days?|d)\s*(?:delay(?:ed)?|late|overdue)/i);
  const n = Number(m?.[1] ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

// ─────────────── Canonical computed status ───────────────
// Single source of truth for a row's status. Compares TAT vs Days Taken
// and terminal/active signals so the dashboard never displays a label
// that contradicts the numbers (root cause of Issues #6/#8/#9 and the
// "In Progress row inside Completed filter" bug).
export type ComputedRowStatus = {
  bucket: StatusBucket;      // used for filtering + grouping
  label: string;             // human label to render in the Status pill
  isDone: boolean;           // true when the row should NOT surface as actionable
  isDelayed: boolean;        // true when the row is actively breaching TAT
  tat: number;
  taken: number;
  delay: number;
};

function sanitizeDuration(raw: number): number {
  // Reject Excel date-serial leaks and impossible values.
  if (!Number.isFinite(raw)) return 0;
  if (raw < 0 || raw > 3650) return 0;
  if (raw >= 30000 && raw <= 70000) return 0;
  return raw;
}

export function computeRowStatus(row: StatusRow): ComputedRowStatus {
  const toNum = (v: unknown) => {
    if (typeof v === "number") return v;
    const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };
  const tat = sanitizeDuration(toNum(row["TAT"]));
  const recomputed = recomputeDaysTaken(row);
  const rawTaken = sanitizeDuration(toNum(row["Days Taken"]));
  // Prefer authoritative recomputed value from Start/End dates; only fall back
  // to the sheet's Days Taken column when we cannot derive it from dates.
  const taken = recomputed ?? rawTaken;

  const explicitDelay = sanitizeDuration(toNum(row["Delay in Days"]));
  const statusText = rowStatusText(row);
  const statusLower = statusText.toLowerCase();
  const explicitlyActive = /(in\s*progress|under\s*progress|ongoing|wip|working|pending|open|not\s*(complete|completed|done|started?)|yet\s*to)/.test(statusLower);
  const explicitlyDelayed = /(delay|late|overdue|breach|slipp)/.test(statusLower);
  const terminal = isTerminalRow(row);

  // Compute delay from numbers first, then fall back to status-text hint.
  const computedBreach = tat > 0 && taken > tat ? taken - tat : 0;
  let delay = Math.max(explicitDelay, computedBreach);
  if (!delay) {
    const m = statusText.match(/(?:delay(?:ed)?|late|overdue)\s*(?:by)?\s*(\d+(?:\.\d+)?)/i)
      || statusText.match(/(\d+(?:\.\d+)?)\s*(?:days?|d)\s*(?:delay(?:ed)?|late|overdue)/i);
    const n = Number(m?.[1] ?? 0);
    if (Number.isFinite(n)) delay = Math.round(n);
  }

  // TERMINAL — the row is completed. Label reflects timely vs late per numbers,
  // never the raw sheet text (which is where "TAT=45 Taken=31 → Timely" errors
  // and "TAT=30 Taken=31 → Completed" errors originate).
  //
  // We also treat two dashboard-parity signals as terminal even when the sheet
  // Status text still says "In Progress":
  //   1. finishedWithinTat — taken>0 & tat>0 & taken<=tat with no active delay
  //   2. date-serial leaked into Delay/Days Taken column (46028/46029) — the
  //      sheet formula stamped a completion date into a duration column.
  // Matches AgentDashboard's `effectivelyDone` so entity pages (Project Health,
  // KPI drill-downs, Person/Stage/Row views) never contradict the dashboard.
  const isSerialLeak = (n: number) => n >= 30000 && n <= 70000;
  const rawDelayNum = toNum(row["Delay in Days"]);
  const rawTakenNum = toNum(row["Days Taken"]);
  const finishedWithinTat = tat > 0 && taken > 0 && taken <= tat && !explicitlyDelayed;
  const serialLeakSaysDone = !explicitlyDelayed && (isSerialLeak(rawDelayNum) || isSerialLeak(rawTakenNum));

  if ((terminal && !explicitlyActive) || finishedWithinTat || serialLeakSaysDone) {
    if (tat > 0 && taken > 0) {
      if (taken > tat) {
        return { bucket: "Completed", label: "Late Completed", isDone: true, isDelayed: false, tat, taken, delay: taken - tat };
      }
      return { bucket: "Completed", label: "Timely Completed", isDone: true, isDelayed: false, tat, taken, delay: 0 };
    }
    return { bucket: "Completed", label: "Completed", isDone: true, isDelayed: false, tat, taken, delay: 0 };
  }


  // ACTIVE — never leak into Completed. If TAT is breached OR status text says
  // delayed, bucket as Delayed. Otherwise honor the explicit active label.
  if (delay > 0 || explicitlyDelayed || (tat > 0 && taken > tat)) {
    return { bucket: "Delayed", label: delay > 0 ? `Delayed (${delay}d)` : "Delayed", isDone: false, isDelayed: true, tat, taken, delay };
  }
  if (explicitlyActive) {
    const bucket = statusBucket(statusText);
    return { bucket: bucket === "Completed" ? "In Progress" : bucket, label: statusText || "In Progress", isDone: false, isDelayed: false, tat, taken, delay: 0 };
  }
  // Fallback to text-based bucket. Only surface a delay when the bucket is
  // actually Delayed — otherwise a stale numeric `delay` from `computeDelay`
  // (e.g. a completed-but-mislabelled row) leaks a phantom "In Progress" delay.
  const b = statusBucket(statusText);
  const bucketOut = b === "Completed" ? "In Progress" : b;
  const isDelayedOut = bucketOut === "Delayed";
  return {
    bucket: bucketOut,
    label: statusText || "—",
    isDone: false,
    isDelayed: isDelayedOut,
    tat,
    taken,
    delay: isDelayedOut ? delay : 0,
  };
}
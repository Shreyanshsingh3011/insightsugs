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
  const completion = valueForAliases(row, COMPLETION_ALIASES);
  return isMeaningfulCompletionValue(completion);
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
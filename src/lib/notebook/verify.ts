// Confirm citations actually point at real records in the enabled data.
import type { Citation } from "./types";
import type { SheetSource } from "./compute";
import type { ConcernLite, ReminderLite } from "./retrieve";

export function verifyCitations(opts: {
  citations: Citation[];
  sheets: SheetSource[];
  concerns: ConcernLite[];
  reminders: ReminderLite[];
}): Citation[] {
  const verified: Citation[] = [];
  for (const c of opts.citations) {
    if (c.type === "sheet") {
      const sheet = opts.sheets.find((s) => s.label === c.sheet);
      if (sheet && typeof c.row === "number" && sheet.rows[c.row]) verified.push(c);
    } else if (c.type === "concern") {
      if (opts.concerns.some((x, i) => x.id === c.id || `idx${i}` === c.id)) verified.push(c);
    } else if (c.type === "reminder") {
      if (opts.reminders.some((x, i) => x.id === c.id || `idx${i}` === c.id)) verified.push(c);
    }
  }
  return verified;
}

// Business-day calendar: add N working days to a date, skipping Sat/Sun and holidays.
export function addBusinessDays(start: Date, days: number, holidays: Set<string> = new Set()): Date {
  const d = new Date(start);
  let remaining = Math.max(0, Math.floor(days));
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    const key = d.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6 && !holidays.has(key)) remaining--;
  }
  return d;
}

export function diffBusinessDays(from: Date, to: Date, holidays: Set<string> = new Set()): number {
  if (to <= from) return 0;
  let n = 0;
  const d = new Date(from);
  while (d < to) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    const key = d.toISOString().slice(0, 10);
    if (day !== 0 && day !== 6 && !holidays.has(key)) n++;
  }
  return n;
}

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function computeDueDate(startISO: string | null, tatDays: number | null, holidays: Set<string>): string | null {
  if (!startISO || !tatDays || tatDays <= 0) return null;
  return toISODate(addBusinessDays(new Date(startISO + "T00:00:00Z"), tatDays, holidays));
}

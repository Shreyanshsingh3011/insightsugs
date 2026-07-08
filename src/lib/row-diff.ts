// Positional row diff for sheet payloads. Google Sheets doesn't expose a
// change feed, so we compare the freshly fetched rows against the previous
// snapshot by row_index and record which cells changed.

export type RowDiff = {
  added: number;
  removed: number;
  changed: number;
  changedIndexes: number[];
  changedColumns: string[];
};

function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    try {
      const keys = Object.keys(v as Record<string, unknown>).sort();
      return JSON.stringify(v, keys);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

export function diffRows(
  prev: Array<Record<string, unknown>> | undefined,
  next: Array<Record<string, unknown>>,
): RowDiff {
  if (!prev || prev.length === 0) {
    return {
      added: next.length,
      removed: 0,
      changed: 0,
      changedIndexes: [],
      changedColumns: [],
    };
  }
  const prevLen = prev.length;
  const nextLen = next.length;
  const overlap = Math.min(prevLen, nextLen);
  const changedIndexes: number[] = [];
  const changedCols = new Set<string>();

  for (let i = 0; i < overlap; i++) {
    const a = prev[i] ?? {};
    const b = next[i] ?? {};
    const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
    let rowChanged = false;
    for (const k of keys) {
      if (k.startsWith("__")) continue; // skip injected fields like __project
      if (stableStringify(a[k]) !== stableStringify(b[k])) {
        rowChanged = true;
        changedCols.add(k);
      }
    }
    if (rowChanged) changedIndexes.push(i);
  }

  return {
    added: Math.max(nextLen - prevLen, 0),
    removed: Math.max(prevLen - nextLen, 0),
    changed: changedIndexes.length,
    changedIndexes: changedIndexes.slice(0, 500),
    changedColumns: Array.from(changedCols).slice(0, 200),
  };
}

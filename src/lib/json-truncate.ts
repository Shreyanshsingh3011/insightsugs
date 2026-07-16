/**
 * Safely truncate a JSON payload for inclusion in an LLM prompt.
 *
 * Naive `JSON.stringify(x).slice(0, N)` chops mid-object and hands the model
 * malformed JSON, which silently corrupts grounding. Prefer row/element-level
 * truncation: serialize element-by-element and stop when the char budget is
 * hit, then append an explicit "(truncated X of Y)" note.
 */
export function truncateJsonForPrompt(
  value: unknown,
  maxChars: number,
): string {
  if (Array.isArray(value)) {
    const total = value.length;
    const parts: string[] = [];
    let used = 2; // opening/closing []
    let kept = 0;
    for (const item of value) {
      let s: string;
      try {
        s = JSON.stringify(item);
      } catch {
        s = '"<unserializable>"';
      }
      const sep = kept === 0 ? 0 : 1; // comma
      if (used + s.length + sep > maxChars) break;
      parts.push(s);
      used += s.length + sep;
      kept += 1;
    }
    const body = `[${parts.join(",")}]`;
    return kept < total
      ? `${body}\n(truncated: showing ${kept} of ${total} items)`
      : body;
  }
  let full: string;
  try {
    full = JSON.stringify(value);
  } catch {
    full = '"<unserializable>"';
  }
  if (full.length <= maxChars) return full;
  // Object too big — send a summary rather than malformed JSON.
  const keys = value && typeof value === "object" ? Object.keys(value as object) : [];
  return `"<object too large: ${full.length} chars, keys=${JSON.stringify(keys).slice(0, 200)}>"`;
}

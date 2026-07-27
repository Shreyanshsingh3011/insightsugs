// Cheap row-count helper.
//
// `select("row_index", { count: "exact", head: true })` forces Postgres to
// scan every row of `sheet_rows` for the registry. In production that single
// pattern accounted for ~1,500s of database time across ~11k calls — more
// than the actual data reads it preceded.
//
// `sheet_registry.row_count` is written by `syncRowsInternal` on every sync,
// so it is authoritative for stored rows. This helper reads that column via
// the primary key (a single index lookup) and only falls back to the exact
// count when the registry has never been synced.
export async function countSheetRows(
  supabase: { from: (t: string) => any },
  registryId: string,
  hint?: number | null,
): Promise<number> {
  if (typeof hint === "number" && hint >= 0) return hint;

  const { data: reg } = await supabase
    .from("sheet_registry")
    .select("row_count")
    .eq("id", registryId)
    .maybeSingle();
  if (typeof reg?.row_count === "number" && reg.row_count >= 0) return reg.row_count;

  const { count } = await supabase
    .from("sheet_rows")
    .select("row_index", { count: "exact", head: true })
    .eq("sheet_registry_id", registryId);
  return count ?? 0;
}

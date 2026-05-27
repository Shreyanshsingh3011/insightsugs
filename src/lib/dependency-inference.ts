// Local dependency inference: fetches a sheet (Apps Script / public JSON) and
// derives a dependency chain from the actual rows + a user-supplied logic
// snippet (or a sensible default rule).

import type { DependencyChainResponse, ChainEdge } from "./dependency-chain";

export interface InferenceInput {
  sheetUrl: string;
  logic?: string; // optional JS body, see DEFAULT_LOGIC
  idColumn?: string;
  dependsOnColumn?: string;
  labelColumn?: string;
}

export const DEFAULT_LOGIC = `// Available: rows, headers, helpers { splitIds }
// Return: { edges:[{from,to,label?}], nodes?: string[], labels?: Record<string,string> }
// Rule: each row's "Sr. No." depends on id(s) listed in "Dependent activities".
// Edge direction = dependency -> current row (so prerequisites come first in topo order).
const ID = "Sr. No.";
const DEP = "Dependent activities";
const NAME = "Process Descriptions";
const edges = [];
const labels = {};
for (const r of rows) {
  const me = String(r[ID] ?? "").trim();
  if (!me) continue;
  labels[me] = String(r[NAME] ?? "").slice(0, 80);
  for (const dep of helpers.splitIds(r[DEP])) {
    if (dep === me) continue;
    edges.push({ from: dep, to: me });
  }
}
return { edges, labels };`;

function splitIds(v: unknown): string[] {
  if (v === null || v === undefined || v === "") return [];
  return String(v)
    .split(/[,;|/\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface RawSheet {
  data?: Record<string, unknown>[];
  headers?: string[];
  rows?: Record<string, unknown>[];
}

async function fetchSheet(url: string): Promise<{ rows: Record<string, unknown>[]; headers: string[] }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Sheet fetch failed: " + res.status);
  const json = (await res.json()) as RawSheet | Record<string, unknown>[];
  const rows = Array.isArray(json) ? json : (json.data ?? json.rows ?? []);
  const headers = Array.isArray(json)
    ? Object.keys(rows[0] ?? {})
    : (json.headers ?? Object.keys(rows[0] ?? {}));
  return { rows: rows as Record<string, unknown>[], headers };
}

function topoSort(nodes: string[], edges: ChainEdge[]): { order: string[]; isDAG: boolean } {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  nodes.forEach((n) => { indeg.set(n, 0); adj.set(n, []); });
  for (const e of edges) {
    if (!adj.has(e.from)) { adj.set(e.from, []); indeg.set(e.from, 0); }
    if (!indeg.has(e.to)) { indeg.set(e.to, 0); adj.set(e.to, []); }
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const queue: string[] = [];
  indeg.forEach((d, n) => { if (d === 0) queue.push(n); });
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of adj.get(n) ?? []) {
      indeg.set(m, (indeg.get(m) ?? 0) - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  return { order, isDAG: order.length === indeg.size };
}

function transitiveClosure(nodes: string[], edges: ChainEdge[]) {
  const adj = new Map<string, Set<string>>();
  nodes.forEach((n) => adj.set(n, new Set()));
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, new Set());
    if (!adj.has(e.to)) adj.set(e.to, new Set());
    adj.get(e.from)!.add(e.to);
  }
  const desc = new Map<string, Set<string>>();
  const visit = (n: string, acc: Set<string>, seen: Set<string>) => {
    for (const m of adj.get(n) ?? []) {
      if (seen.has(m)) continue;
      seen.add(m); acc.add(m);
      visit(m, acc, seen);
    }
  };
  for (const n of adj.keys()) {
    const s = new Set<string>();
    visit(n, s, new Set());
    desc.set(n, s);
  }
  const anc = new Map<string, Set<string>>();
  for (const n of adj.keys()) anc.set(n, new Set());
  for (const [n, ds] of desc) for (const d of ds) anc.get(d)!.add(n);

  const transitive: Record<string, { ancestors: string[]; descendants: string[] }> = {};
  for (const n of adj.keys()) {
    transitive[n] = {
      ancestors: Array.from(anc.get(n) ?? []),
      descendants: Array.from(desc.get(n) ?? []),
    };
  }
  // skip edges = transitive edges not in direct edges
  const directSet = new Set(edges.map((e) => `${e.from}→${e.to}`));
  const skipEdges: ChainEdge[] = [];
  for (const [from, ds] of desc) {
    for (const to of ds) {
      if (!directSet.has(`${from}→${to}`)) skipEdges.push({ from, to });
    }
  }
  return { transitive, skipEdges };
}

export async function inferDependencyChain(input: InferenceInput): Promise<DependencyChainResponse> {
  const { rows, headers } = await fetchSheet(input.sheetUrl);
  const logic = (input.logic ?? DEFAULT_LOGIC).trim();

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("rows", "headers", "helpers", `"use strict";${logic}`) as (
    rows: Record<string, unknown>[],
    headers: string[],
    helpers: { splitIds: typeof splitIds },
  ) => { edges: ChainEdge[]; nodes?: string[]; labels?: Record<string, string> };

  const out = fn(rows, headers, { splitIds });
  const rawEdges: ChainEdge[] = (out.edges ?? []).map((e) => ({
    from: String(e.from),
    to: String(e.to),
    label: e.label,
  })).filter((e) => e.from && e.to);

  const nodeSet = new Set<string>(out.nodes?.map(String) ?? []);
  for (const e of rawEdges) { nodeSet.add(e.from); nodeSet.add(e.to); }
  const nodes = Array.from(nodeSet);
  const nodeLabels: Record<string, string> = {};
  if (out.labels) for (const [k, v] of Object.entries(out.labels)) nodeLabels[String(k)] = String(v);

  const { order, isDAG } = topoSort(nodes, rawEdges);
  const { transitive, skipEdges } = transitiveClosure(nodes, rawEdges);

  return {
    version: 2,
    source: { url: input.sheetUrl, headers, rowIds: rows.map((_, i) => String(i + 1)) },
    edges: rawEdges.map((e, i) => ({
      id: `local-${i}`,
      from: [{ t: "row", i: e.from }],
      to: [{ t: "row", i: e.to }],
      label: e.label,
    })),
    chain: {
      nodes,
      directEdges: rawEdges,
      skipEdges,
      transitive,
      topoOrder: order,
      isDAG,
      stats: {
        nodeCount: nodes.length,
        directCount: rawEdges.length,
        skipCount: skipEdges.length,
        transitiveEdgeCount: Object.values(transitive).reduce((a, t) => a + t.descendants.length, 0),
      },
    },
  };
}

// Local dependency inference: fetches a sheet (Apps Script / public JSON) and
// derives a dependency chain from the actual rows + a user-supplied logic
// snippet. Supports two return shapes from the user's JS body:
//   1. Mapping: { taskColumn, assignedColumn, dependencyColumn, statusColumn, delayColumn }
//   2. Advanced: { edges:[{from,to,label?}], nodes?, labels?, meta? }

import type { DependencyChainResponse, ChainEdge, NodeMeta } from "./dependency-chain";

export interface InferenceInput {
  sheetUrl: string;
  logic?: string;
}

export const DEFAULT_LOGIC = `// Map the sheet columns to dependency fields.
// Available: rows, headers, helpers { splitIds }
// Return either this mapping shape OR an advanced { edges, labels } shape.
return {
  taskColumn: "Task Name",
  assignedColumn: "Assigned To",
  dependencyColumn: "Depends On",
  statusColumn: "Status",
  delayColumn: "Delay Days"
};`;

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
  const directSet = new Set(edges.map((e) => `${e.from}→${e.to}`));
  const skipEdges: ChainEdge[] = [];
  for (const [from, ds] of desc) {
    for (const to of ds) {
      if (!directSet.has(`${from}→${to}`)) skipEdges.push({ from, to });
    }
  }
  return { transitive, skipEdges };
}

interface MappingResult {
  taskColumn?: string;
  assignedColumn?: string;
  dependencyColumn?: string;
  statusColumn?: string;
  delayColumn?: string;
}
interface AdvancedResult {
  edges?: ChainEdge[];
  nodes?: string[];
  labels?: Record<string, string>;
  meta?: Record<string, NodeMeta>;
}

function deriveFromMapping(
  rows: Record<string, unknown>[],
  m: MappingResult,
): { edges: ChainEdge[]; labels: Record<string, string>; meta: Record<string, NodeMeta> } {
  const taskCol = m.taskColumn ?? "Task Name";
  const depCol = m.dependencyColumn ?? "Depends On";
  const assignCol = m.assignedColumn;
  const statusCol = m.statusColumn;
  const delayCol = m.delayColumn;

  const edges: ChainEdge[] = [];
  const labels: Record<string, string> = {};
  const meta: Record<string, NodeMeta> = {};

  for (const r of rows) {
    const task = String(r[taskCol] ?? "").trim();
    if (!task) continue;
    labels[task] = task;
    const delayRaw = delayCol ? r[delayCol] : undefined;
    const delayNum = typeof delayRaw === "number" ? delayRaw : parseFloat(String(delayRaw ?? ""));
    meta[task] = {
      task,
      assignee: assignCol ? String(r[assignCol] ?? "").trim() || undefined : undefined,
      status: statusCol ? String(r[statusCol] ?? "").trim() || undefined : undefined,
      delay: Number.isFinite(delayNum) ? delayNum : 0,
    };
    for (const dep of splitIds(r[depCol])) {
      if (dep === task) continue;
      edges.push({ from: dep, to: task });
    }
  }
  // Ensure dependency-only nodes have labels too
  for (const e of edges) {
    if (!labels[e.from]) labels[e.from] = e.from;
    if (!meta[e.from]) meta[e.from] = { task: e.from };
  }
  return { edges, labels, meta };
}

interface EmergentPayload {
  src?: { u?: string; h?: string[]; r?: string[] };
  cn?: string[];
  ce?: { f: string; t: string; k?: string; l?: string }[];
  e?: unknown[];
}

function tryDecodeEmergent(s: string): EmergentPayload | null {
  const v = s.trim();
  if (!v) return null;
  let token: string | null = null;
  if (v.startsWith("http")) {
    try {
      const u = new URL(v);
      token = u.searchParams.get("d");
    } catch { return null; }
  } else if (/^eyJ/.test(v)) {
    token = v;
  }
  if (!token) return null;
  try {
    // base64 → JSON (tolerate url-safe and missing padding)
    const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? b64 + "=".repeat(4 - (b64.length % 4)) : b64;
    const json = atob(pad);
    return JSON.parse(json) as EmergentPayload;
  } catch { return null; }
}

function mappingFromEmergent(p: EmergentPayload, headers: string[]): MappingResult {
  const has = (h: string) => headers.includes(h);
  const pick = (...cands: string[]) => cands.find((c) => has(c));
  const ce = p.ce?.[0];
  const taskColumn = ce?.f && has(ce.f) ? ce.f : pick("Sr. No.", "ID", "Id");
  const dependencyColumn = ce?.t && has(ce.t) ? ce.t : pick("Dependent activities", "Depends On", "Dependencies");
  return {
    taskColumn,
    dependencyColumn,
    assignedColumn: pick("Responsible Person", "Assigned To", "Owner", "approvers name"),
    statusColumn: pick("Status as on Date", "Status"),
    delayColumn: pick("Days Taken", "Delay Days", "Delay"),
  };
}

export async function inferDependencyChain(input: InferenceInput): Promise<DependencyChainResponse> {
  const rawLogic = (input.logic ?? "").trim();
  const emergent = tryDecodeEmergent(rawLogic);

  // Resolve effective sheet URL: Emergent payload's src.u takes precedence
  const sheetUrl = emergent?.src?.u || input.sheetUrl;
  if (!sheetUrl) throw new Error("No sheet URL provided");

  const { rows, headers } = await fetchSheet(sheetUrl);

  // If logic is an Emergent URL/token, synthesise mapping from its descriptor.
  if (emergent) {
    const m = mappingFromEmergent(emergent, headers);
    // Pick a friendly label column (truncated process description)
    const labelCol = ["Process Descriptions", "Stages of Process", "Task Name"].find((c) => headers.includes(c));
    const derived = deriveFromMapping(rows, m);
    if (labelCol) {
      for (const r of rows) {
        const id = String(r[m.taskColumn ?? ""] ?? "").trim();
        const lbl = String(r[labelCol] ?? "").trim();
        if (id && lbl) derived.labels[id] = lbl.length > 60 ? lbl.slice(0, 57) + "…" : lbl;
      }
    }
    return finalise(sheetUrl, headers, rows, derived.edges, derived.labels, derived.meta);
  }

  const logic = rawLogic || DEFAULT_LOGIC;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("rows", "headers", "helpers", `"use strict";${logic}`) as (
    rows: Record<string, unknown>[],
    headers: string[],
    helpers: { splitIds: typeof splitIds },
  ) => MappingResult & AdvancedResult;

  const out = fn(rows, headers, { splitIds });

  let rawEdges: ChainEdge[] = [];
  let nodeLabels: Record<string, string> = {};
  let nodeMeta: Record<string, NodeMeta> = {};

  if (out && (out.taskColumn || out.dependencyColumn || out.assignedColumn)) {
    const derived = deriveFromMapping(rows, out);
    rawEdges = derived.edges;
    nodeLabels = derived.labels;
    nodeMeta = derived.meta;
  } else {
    rawEdges = (out.edges ?? []).map((e) => ({
      from: String(e.from),
      to: String(e.to),
      label: e.label,
    })).filter((e) => e.from && e.to);
    if (out.labels) for (const [k, v] of Object.entries(out.labels)) nodeLabels[String(k)] = String(v);
    if (out.meta) for (const [k, v] of Object.entries(out.meta)) nodeMeta[String(k)] = v;
  }

  const extraNodes = out.nodes?.map(String) ?? [];
  for (const n of extraNodes) {
    if (!nodeLabels[n]) nodeLabels[n] = n;
  }
  return finalise(sheetUrl, headers, rows, rawEdges, nodeLabels, nodeMeta);
}

function finalise(
  sheetUrl: string,
  headers: string[],
  rows: Record<string, unknown>[],
  rawEdges: ChainEdge[],
  nodeLabels: Record<string, string>,
  nodeMeta: Record<string, NodeMeta>,
): DependencyChainResponse {
  const nodeSet = new Set<string>();
  for (const e of rawEdges) { nodeSet.add(e.from); nodeSet.add(e.to); }
  for (const k of Object.keys(nodeLabels)) nodeSet.add(k);
  const nodes = Array.from(nodeSet);

  const { order, isDAG } = topoSort(nodes, rawEdges);
  const { transitive, skipEdges } = transitiveClosure(nodes, rawEdges);

  return {
    version: 2,
    source: { url: sheetUrl, headers, rowIds: rows.map((_, i) => String(i + 1)) },
    nodeLabels,
    nodeMeta,
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

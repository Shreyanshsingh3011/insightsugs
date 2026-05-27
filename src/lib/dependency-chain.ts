export const RESOLVE_URL =
  "https://depcheck.preview.emergentagent.com/api/studio/resolve?d=eyJ2IjoyLCJzcmMiOnsidSI6Imh0dHBzOi8vY29ubmVjdG9yLWZsb3ctMS5wcmV2aWV3LmVtZXJnZW50YWdlbnQuY29tL2FwaS9wdWJsaWMvZjg5YjY5YjBkODIyYTdkYmQyM2Q5NjM5NDQyMzk5N2QiLCJoIjpbIlNyLiBOby4iLCJCIiwiU3RhZ2VzIG9mIFByb2Nlc3MiLCJEIiwiRSIsIkYiLCJHIiwiRGVwYXJ0bWVudCIsImFwcHJvdmVycyBuYW1lIiwiYXBwcm92ZXJzIGVtYWlsIGlkIiwiRGVwZW5kZW50IGFjdGl2aXRpZXMiLCJQcm9qZWN0IiwiQ3JpdGljYWxpdHkiLCJQcm9jZXNzIERlc2NyaXB0aW9ucyIsIlN0YXJ0IERhdGUiLCJUQVQiLCJTdGF0dXMgYXMgb24gRGF0ZSIsIkhDLTEiLCJEYXlzIFRha2VuIiwiVCIsIkNvbXBsZXRpb24gRGF0ZSBVcGRhdGVkICBieSBQcm9qZWN0IFRlYW0iLCJDb21wbGV0aW9uIERhdGUgVmVyaWZpZWQgYnkgVkhzIiwiUmVzcG9uc2libGUgUGVyc29uIiwiUmVzcG9uc2libGUgUGVyc29uIE1haWwgSUQiLCJZIiwiWiIsIkFBIiwiQUIiLCJBQyIsIkFEIiwiQUUiLCJBRiIsIkFHIiwiQUgiLCJBSSIsIkFKIiwiQUsiLCJBTCIsIkFNIl0sInIiOlsiMjUiLCIyNiIsIjI3IiwiMjgiLCIyOSIsIjMwIiwiNTMiLCI1NCIsIjU1IiwiNTYiLCI1NyIsIjU4IiwiNzMiLCI3MyMxIiwiNzMjMiIsIjczIzMiXX0sImciOltdLCJlIjpbeyJpIjoiZS1tcG5uaTlzbi0zMmFlIiwiZiI6W3sidCI6ImNvbCIsImkiOiJTci4gTm8uIn1dLCJ0IjpbeyJ0IjoiY29sIiwiaSI6IkRlcGVuZGVudCBhY3Rpdml0aWVzIn1dLCJjIjoiMToxIiwibCI6IiIsImZpIjoxfV0sImNuIjpbXSwiY2UiOltdfQ";

export interface ChainEndpoint {
  t: string;
  i: string;
}
export interface ConfiguredEdge {
  id: string;
  from: ChainEndpoint[];
  to: ChainEndpoint[];
  cardinality?: string;
  label?: string;
  fanIn?: boolean;
}
export interface ChainEdge {
  from: string;
  to: string;
  label?: string;
}
export interface DependencyChainResponse {
  version: number;
  source: {
    url: string;
    headers: string[];
    rowIds: string[];
  } | null;
  edges: ConfiguredEdge[];
  chain: {
    nodes: string[];
    directEdges: ChainEdge[];
    skipEdges: ChainEdge[];
    transitive: Record<string, { ancestors: string[]; descendants: string[] }>;
    topoOrder: string[];
    isDAG: boolean;
    stats: {
      nodeCount: number;
      directCount: number;
      skipCount: number;
      transitiveEdgeCount: number;
    };
  };
}

const RESOLVER_BASE = "https://depcheck.preview.emergentagent.com/api/studio/resolve";

/**
 * Accepts:
 *  - full resolver URL (https://…/resolve?d=…)
 *  - just the `d` token (eyJ…)
 *  - a raw sheet/source URL (https://connector-flow-1…/api/public/<code>) → wrapped into a minimal resolver payload
 *  - empty/undefined → default RESOLVE_URL
 */
export function buildResolverUrl(input?: string): string {
  const v = (input ?? "").trim();
  if (!v) return RESOLVE_URL;
  if (v.startsWith("http")) {
    if (v.includes("/api/studio/resolve")) return v;
    // raw source URL — wrap into minimal resolver descriptor
    const payload = { v: 2, src: { u: v, h: [], r: [] }, g: [], e: [], cn: [], ce: [] };
    const token = btoa(JSON.stringify(payload));
    return `${RESOLVER_BASE}?d=${token}`;
  }
  // assume bare token
  return `${RESOLVER_BASE}?d=${v}`;
}

export async function loadDependencyChain(input?: string): Promise<DependencyChainResponse> {
  const url = buildResolverUrl(input);
  const res = await fetch(url);
  if (!res.ok) throw new Error("Resolver " + res.status);
  return res.json();
}

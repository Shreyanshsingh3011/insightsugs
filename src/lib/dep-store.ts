// Tiny shared store so the Copilot can read the latest resolved dependency
// chain without prop drilling from DependencyChainPanel.
import type { DependencyChainResponse } from "./dependency-chain";

export interface DepSnapshot {
  chain: DependencyChainResponse | null;
  insights: {
    topBlocker?: { id: string; label: string; downstream: number };
    criticalChain?: string[];
    atRisk?: string[];
    mostDelayedPerson?: { name: string; totalDelay: number };
  };
}

let snapshot: DepSnapshot = { chain: null, insights: {} };
const listeners = new Set<() => void>();

export const depStore = {
  get: (): DepSnapshot => snapshot,
  set: (s: DepSnapshot) => {
    snapshot = s;
    listeners.forEach((l) => l());
  },
  subscribe: (l: () => void): (() => void) => {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
};

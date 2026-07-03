import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link, useNavigate } from "@tanstack/react-router";
// (Aggregate detail payload retired — every card now deep-links to its own dedicated page.)
import { encodeKey as encodeEntityKey, encodeRowKey } from "@/lib/entity-scope";
import { fetchInsightUrl } from "@/lib/insights-proxy.functions";
import { fetchAgentProjects, type AgentProject } from "@/lib/agent-registry.functions";
import { generateGeminiFn } from "@/lib/gemini.functions";
import { useAgentScope, rowMatchesUser } from "@/hooks/useAgentScope";
import { useProfileDirectory } from "@/hooks/useProfileDirectory";
import { resolvePersonForRow, type ProfileDirectory } from "@/lib/person-resolver";
import { ProjectAssignmentPicker } from "@/components/ProjectAssignmentPicker";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  RadialBarChart, RadialBar, PolarAngleAxis,
} from "recharts";
import {
  Sparkles, RefreshCw, TrendingUp, Users, Activity, Target, Zap,
  CheckCircle2, Clock, Loader2, AlertTriangle, Bot, Send, ArrowRight,
  Flame, Gauge, Radar, Layers, Download, Filter, User as UserIcon, FolderKanban,
} from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

// ────────────────── FIXED SOURCES (fallback if master sheet unavailable) ──────────────────
const FALLBACK_PROJECTS: AgentProject[] = [
  { id: "nit58", label: "NIT-58",        url: "https://sheet2api-bypassed-login.vercel.app/api/public/a02c5f0800319fabb6d0679ec385de83" },
  { id: "pspcl", label: "PSPCL Kharar",  url: "https://sheet2api-bypassed-login.vercel.app/api/public/80d914878c5b9a85de90b59f5eaec11a" },
  { id: "hp",    label: "Himachal",      url: "https://sheet2api-bypassed-login.vercel.app/api/public/f0fc62c15a274dc4c149c2b0a69e2f86" },
  { id: "ula",   label: "ULA 1.1 Bihar", url: "https://sheet2api-bypassed-login.vercel.app/api/public/f84b4f7ebb2380bc85f27cba8a676a1d" },
  { id: "nit76", label: "NIT-76",        url: "https://sheet2api-bypassed-login.vercel.app/api/public/f81e454c36f9c0c609d103ba99e950b4" },
];
const AUTO_REFRESH_MS = 60_000;
const REGISTRY_REFRESH_MS = 5 * 60_000;

// ────────────────── TYPES ──────────────────
type Row = Record<string, unknown>;
type SourcePayload = { connector?: string; department?: string; data?: Row[]; generated_at?: string };
type Payload = { project?: string; department?: string; data?: Row[]; generated_at?: string };

const TONE = {
  high: "text-rose-600 bg-rose-500/10 border-rose-500/30",
  med: "text-amber-700 bg-amber-500/10 border-amber-500/30",
  low: "text-slate-600 bg-slate-500/10 border-slate-500/30",
  ok: "text-emerald-700 bg-emerald-500/10 border-emerald-500/30",
} as const;

// Alias-tolerant field access — projects use different column names.
function pick(r: Row, ...keys: string[]): string {
  for (const k of keys) {
    const v = r[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return "";
}
function num(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function bucket(s: string): "Completed" | "In Progress" | "Delayed" | "Not Started" | "Other" {
  const x = (s || "").toLowerCase();
  if (/complete|done/.test(x)) return "Completed";
  if (/progress|ongoing|wip/.test(x)) return "In Progress";
  if (/delay|overdue|late|breach/.test(x)) return "Delayed";
  if (/not start|yet|pending/.test(x)) return "Not Started";
  return "Other";
}


// ────────────────── DERIVE ──────────────────
function derive(payload: Payload | undefined) {
  const rows = payload?.data ?? [];
  const n = rows.length;
  const status: Record<string, number> = {};
  const stageAgg: Record<string, { total: number; delayed: number; delayDays: number; completed: number }> = {};
  const personAgg: Record<string, { total: number; delayed: number; delayDays: number; completed: number; tat: number; taken: number; email?: string }> = {};
  const critAgg: Record<string, number> = {};
  const processAgg: Record<string, { total: number; delayed: number; delayDays: number }> = {};
  let totalDelay = 0, delayedCount = 0, overdueCount = 0, completedCount = 0;
  let sumTat = 0, sumTaken = 0, tatCounted = 0;
  const overdue: { activity: string; person: string; stage: string; delay: number; tat: number; taken: number; status: string; criticality: string; email: string; row: Row }[] = [];

  for (const r of rows) {
    const st = bucket(pick(r, "Status Category", "Status as on Date"));
    status[st] = (status[st] || 0) + 1;
    const stage = pick(r, "Stages", "Stages of Process") || "—";
    const person = pick(r, "Responsible Person", "Responsibility", "approvers name") || "Unassigned";
    const crit = pick(r, "Criticality") || "—";
    const process = pick(r, "Process", "Process Descriptions") || "—";
    const email = pick(r, "Responsible Person Mail ID", "approvers email id");
    const delay = num(r["Delay in Days"]);
    const tat = num(r["TAT"]);
    const taken = num(r["Days Taken"]);

    critAgg[crit] = (critAgg[crit] || 0) + 1;
    stageAgg[stage] ??= { total: 0, delayed: 0, delayDays: 0, completed: 0 };
    stageAgg[stage].total++;
    processAgg[process] ??= { total: 0, delayed: 0, delayDays: 0 };
    processAgg[process].total++;
    personAgg[person] ??= { total: 0, delayed: 0, delayDays: 0, completed: 0, tat: 0, taken: 0, email };
    personAgg[person].total++;
    personAgg[person].tat += tat;
    personAgg[person].taken += taken;
    if (tat > 0) { sumTat += tat; sumTaken += taken; tatCounted++; }

    const isDelayed = st === "Delayed" || (st !== "Completed" && taken > tat && tat > 0);
    if (st === "Completed") { completedCount++; personAgg[person].completed++; stageAgg[stage].completed++; }
    if (isDelayed) {
      delayedCount++; personAgg[person].delayed++; stageAgg[stage].delayed++;
      processAgg[process].delayed++; personAgg[person].delayDays += delay;
      stageAgg[stage].delayDays += delay; processAgg[process].delayDays += delay;
      totalDelay += delay;
    }
    if (st !== "Completed" && delay > 0) overdueCount++;
    if (st !== "Completed" && (delay > 0 || (tat > 0 && taken > tat))) {
      overdue.push({
        activity: pick(r, "Activity List", "Process Descriptions", "Process") || "(unnamed)",
        person, stage, delay, tat, taken,
        status: pick(r, "Status Category", "Status as on Date"), criticality: crit,
        email, row: r,
      });
    }
  }


  const persons = Object.entries(personAgg)
    .filter(([k]) => k && k !== "Unassigned")
    .map(([person, v]) => {
      const completionPct = v.total ? (v.completed / v.total) * 100 : 0;
      const onTimePct = v.total ? Math.max(0, 100 - (v.delayed / v.total) * 100) : 100;
      const paceRatio = v.tat > 0 ? Math.min(200, (v.taken / v.tat) * 100) : 100;
      // Efficiency Index: completion + on-time weighted, penalized by slow pace
      const efficiency = Math.max(0, Math.min(100, Math.round(0.5 * completionPct + 0.5 * onTimePct - Math.max(0, paceRatio - 100) * 0.3)));
      return {
        person, email: v.email || "",
        total: v.total, delayed: v.delayed, completed: v.completed,
        delayDays: v.delayDays,
        efficiency,
        riskScore: v.total ? Math.round((v.delayed / v.total) * 100) : 0,
        paceRatio: Math.round(paceRatio),
      };
    });

  const personsByBurden = [...persons].sort((a, b) => b.delayDays - a.delayDays);
  const topPerformers = [...persons].filter(p => p.total >= 2).sort((a, b) => b.efficiency - a.efficiency);

  const stages = Object.entries(stageAgg).map(([stage, v]) => ({
    stage, total: v.total, delayed: v.delayed, delayDays: v.delayDays,
    completed: v.completed,
    healthPct: v.total ? Math.round(((v.total - v.delayed) / v.total) * 100) : 100,
  })).sort((a, b) => b.delayDays - a.delayDays);

  const processes = Object.entries(processAgg).map(([process, v]) => ({
    process, total: v.total, delayed: v.delayed, delayDays: v.delayDays,
  })).sort((a, b) => b.delayDays - a.delayDays).slice(0, 8);

  overdue.sort((a, b) => b.delay - a.delay);

  const completionRate = n ? Math.round((completedCount / n) * 100) : 0;
  const delayRate = n ? Math.round((delayedCount / n) * 100) : 0;
  const avgDelay = delayedCount ? Math.round(totalDelay / delayedCount) : 0;
  const paceRatio = tatCounted ? Math.round((sumTaken / Math.max(1, sumTat)) * 100) : 100;
  const onTimeRate = 100 - delayRate;
  // Health = 0.4·onTime + 0.4·completion + 0.2·(200-pace) capped
  const healthScore = Math.max(0, Math.min(100, Math.round(
    0.4 * onTimeRate + 0.4 * completionRate + 0.2 * Math.max(0, 200 - paceRatio) / 2
  )));

  // Forecast: at current completion velocity per row, days to finish remaining
  const remaining = n - completedCount;
  const avgTat = tatCounted ? sumTat / tatCounted : 0;
  const projectedDaysToFinish = remaining && avgTat
    ? Math.round(remaining * avgTat * (paceRatio / 100) / Math.max(1, Object.keys(personAgg).length))
    : 0;

  // ── AGENTIC RULES: Next Best Actions
  type Action = {
    id: string; title: string; detail: string;
    severity: keyof typeof TONE; source: string; impact: number;
    row?: Row; person?: string; stage?: string; email?: string;
  };
  const actions: Action[] = [];
  overdue.slice(0, 6).forEach((o, i) => {
    const sev = o.criticality === "Critical" || o.delay > 60 ? "high" : o.delay > 20 ? "med" : "low";
    actions.push({
      id: `ov-${i}`,
      title: `Unblock "${o.activity}"`,
      detail: `${o.delay}d overdue · ${o.person} · ${o.stage}. TAT ${o.tat}d vs taken ${o.taken}d. Escalate + commit recovery date.`,
      severity: sev, source: "Overdue", impact: o.delay,
      row: o.row, person: o.person, stage: o.stage, email: o.email,
    });
  });
  personsByBurden.slice(0, 3).forEach((p, i) => {
    if (p.riskScore >= 30 && p.total >= 2) {
      actions.push({
        id: `p-${i}`, source: "Ownership",
        title: `Rebalance ${p.person}`,
        detail: `${p.delayed}/${p.total} delayed (${p.riskScore}%). Efficiency ${p.efficiency}. Redistribute or pair up.`,
        severity: p.riskScore >= 60 ? "high" : "med", impact: p.delayDays,
        person: p.person, email: p.email,
      });
    }
  });
  stages.slice(0, 3).forEach((s, i) => {
    if (s.delayed > 0 && s.healthPct < 70) {
      actions.push({
        id: `s-${i}`, source: "Bottleneck",
        title: `Fix ${s.stage}`,
        detail: `Only ${s.healthPct}% healthy · ${s.delayed}/${s.total} delayed · ${s.delayDays}d cumulative. Audit handoffs and dependencies.`,
        severity: s.healthPct < 40 ? "high" : "med", impact: s.delayDays,
        stage: s.stage,
      });
    }
  });
  const notStarted = status["Not Started"] || 0;
  if (n && notStarted / n > 0.25) {
    actions.push({
      id: "ns-1", source: "Backlog",
      title: `Kick off ${notStarted} not-started activities`,
      detail: `${Math.round((notStarted / n) * 100)}% haven't started. Confirm dependencies and assign start dates this week.`,
      severity: "med", impact: notStarted,
    });
  }
  if (paceRatio > 130) {
    actions.push({
      id: "pace-1", source: "Pace",
      title: `Compress cycle time (running ${paceRatio}% of TAT)`,
      detail: `Team is systematically over-shooting TAT. Re-baseline estimates or remove wait-states before scoping new work.`,
      severity: "med", impact: paceRatio - 100,
    });
  }
  actions.sort((a, b) => (b.severity === "high" ? 2 : b.severity === "med" ? 1 : 0) - (a.severity === "high" ? 2 : a.severity === "med" ? 1 : 0) || b.impact - a.impact);

  // Anomalies: activities where taken >> tat
  const anomalies = rows
    .map(r => {
      const tat = num(r["TAT"]);
      const taken = num(r["Days Taken"]);
      return {
        activity: pick(r, "Activity List", "Process Descriptions", "Process") || "(unnamed)",
        person: pick(r, "Responsible Person", "Responsibility", "approvers name") || "—",
        stage: pick(r, "Stages", "Stages of Process") || "—",
        tat, taken,
        ratio: tat > 0 ? taken / tat : 0,
      };
    })
    .filter(a => a.tat > 0 && a.ratio >= 1.8)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 6);


  return {
    n, status, critAgg, persons, personsByBurden, topPerformers, stages, processes, overdue, anomalies,
    completionRate, delayRate, healthScore, avgDelay, paceRatio, onTimeRate, projectedDaysToFinish,
    totals: { total: n, completed: completedCount, delayed: delayedCount, overdue: overdueCount, notStarted },
    actions,
  };
}

// ────────────────── COMPONENT ──────────────────
export default function AgentDashboard() {
  const fetchUrl = useServerFn(fetchInsightUrl);
  const fetchRegistry = useServerFn(fetchAgentProjects);
  const genFn = useServerFn(generateGeminiFn);

  const scope = useAgentScope();
  const { directory: profileDir } = useProfileDirectory();

  // Persist the project selector across navigations so returning from the
  // detail page keeps the drill-down context intact.
  const [selected, setSelected] = useState<string>(() => {
    if (typeof window === "undefined") return "all";
    return sessionStorage.getItem("agent:selected") ?? "all";
  });
  useEffect(() => {
    if (typeof window !== "undefined") sessionStorage.setItem("agent:selected", selected);
  }, [selected]);

  // Live registry pulled from the master Google Sheet — falls back if unavailable.
  const registryQ = useQuery({
    queryKey: ["agent-registry"],
    queryFn: () => fetchRegistry(),
    staleTime: REGISTRY_REFRESH_MS,
    refetchInterval: REGISTRY_REFRESH_MS,
    refetchOnWindowFocus: false,
  });

  const allProjects: AgentProject[] = useMemo(() => {
    const live = registryQ.data?.projects;
    return live && live.length ? live : FALLBACK_PROJECTS;
  }, [registryQ.data]);
  const registryLive = !!registryQ.data?.projects?.length;

  // Super admins (MD, VH) see every project. Everyone else sees only assigned.
  const projects: AgentProject[] = useMemo(() => {
    if (scope.mode === "all") return allProjects;
    if (!scope.allowedProjectKeys) return allProjects;
    return allProjects.filter((p) => scope.allowedProjectKeys!.has(p.id));
  }, [allProjects, scope.mode, scope.allowedProjectKeys]);

  const assignedKeys = useMemo(
    () => scope.assignments.map((a) => a.project_key),
    [scope.assignments],
  );
  const needsOnboarding = scope.mode !== "all" && !scope.loading && projects.length === 0;

  const queries = useQueries({
    queries: projects.map(p => ({
      queryKey: ["agent-src", p.id, p.url],
      queryFn: async () => {
        const res = await fetchUrl({ data: { url: p.url } });
        return { project: p, payload: (res as { payload?: SourcePayload }).payload };
      },
      staleTime: AUTO_REFRESH_MS,
      refetchInterval: AUTO_REFRESH_MS,
      refetchOnWindowFocus: true,
    })),
  });

  const sources = queries.map((q, i) => ({
    project: projects[i],
    payload: (q.data as { payload?: SourcePayload } | undefined)?.payload,
    isFetching: q.isFetching,
    isLoading: q.isLoading,
    isError: q.isError,
    error: q.error as Error | undefined,
  }));

  const anyLoading = queries.some(q => q.isLoading);
  const anyFetching = queries.some(q => q.isFetching);
  const allError = queries.every(q => q.isError);
  const lastSyncedAt = sources
    .map(s => s.payload?.generated_at)
    .filter((x): x is string => !!x)
    .sort()
    .pop();

  // ── ADMIN / SUPER FOCUS FILTERS ────────────────────────────────────────────
  // Regular users are already row-scoped by name. Admin & super_admin see the
  // full data of their assigned/all projects, so give them focus controls that
  // reshape the ENTIRE dashboard (KPIs, health, efficiency, chart, brief) by
  // Person and Department/Team. Persisted in sessionStorage so drill-downs
  // return to the same focus.
  const [focusPerson, setFocusPerson] = useState<string>(() => {
    if (typeof window === "undefined") return "all";
    return sessionStorage.getItem("agent:focus:person") ?? "all";
  });
  const [focusDept, setFocusDept] = useState<string>(() => {
    if (typeof window === "undefined") return "all";
    return sessionStorage.getItem("agent:focus:dept") ?? "all";
  });
  useEffect(() => {
    if (typeof window !== "undefined") sessionStorage.setItem("agent:focus:person", focusPerson);
  }, [focusPerson]);
  useEffect(() => {
    if (typeof window !== "undefined") sessionStorage.setItem("agent:focus:dept", focusDept);
  }, [focusDept]);
  const canFocus = scope.isAdmin; // includes super_admin

  const payload: Payload | undefined = useMemo(() => {
    const nameFilter = (rows: Row[] | undefined): Row[] => {
      if (!rows) return [];
      if (scope.mode !== "name-scoped") return rows;
      if (scope.nameNeedles.length === 0) return [];
      return rows.filter((r) => rowMatchesUser(r, scope.nameNeedles));
    };
    const focusFilter = (rows: Row[]): Row[] => {
      if (!canFocus) return rows;
      if (focusPerson === "all" && focusDept === "all") return rows;
      const p = focusPerson.toLowerCase();
      const dep = focusDept.toLowerCase();
      return rows.filter((r) => {
        if (focusPerson !== "all") {
          const person = String(r["Responsible Person"] ?? r["Responsibility"] ?? r["approvers name"] ?? "").toLowerCase();
          const email = String(r["Responsible Person Mail ID"] ?? r["approvers email id"] ?? "").toLowerCase();
          if (person !== p && email !== p) return false;
        }
        if (focusDept !== "all") {
          const rowDept = String(r["Department"] ?? r["Vertical"] ?? r["Team"] ?? r["__department"] ?? "").toLowerCase();
          if (rowDept !== dep) return false;
        }
        return true;
      });
    };
    if (selected === "all") {
      const merged: Row[] = [];
      let latest: string | undefined;
      for (const s of sources) {
        const filtered = nameFilter(s.payload?.data);
        if (filtered.length) {
          const label = s.project.label;
          const dept = s.payload?.department;
          for (const r of filtered) merged.push({ ...r, __project: label, __department: dept });
          if (s.payload?.generated_at && (!latest || s.payload.generated_at > latest)) latest = s.payload.generated_at;
        }
      }
      const finalRows = focusFilter(merged);
      return finalRows.length ? { project: scope.mode === "name-scoped" ? "My work · all projects" : "All projects", data: finalRows, generated_at: latest } : undefined;
    }
    const s = sources.find(x => x.project.id === selected);
    if (!s?.payload) return undefined;
    const scoped = nameFilter(s.payload.data);
    if (!scoped.length && scope.mode === "name-scoped") return undefined;
    const tagged = scoped.map((r) => ({ ...r, __department: s.payload?.department }));
    const data = focusFilter(tagged);
    return {
      project: (scope.mode === "name-scoped" ? "My work · " : "") + (s.payload.connector || s.project.label),
      department: s.payload.department,
      data,
      generated_at: s.payload.generated_at,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, queries.map(q => q.dataUpdatedAt).join(","), scope.mode, scope.nameNeedles.join("|"), canFocus, focusPerson, focusDept]);

  const d = useMemo(() => derive(payload), [payload]);

  // Options for the admin focus bar — derived from the UNFILTERED scoped rows
  // so admins can always pivot back and see the full option list.
  const focusOptions = useMemo(() => {
    const persons = new Set<string>();
    const depts = new Set<string>();
    for (const s of sources) {
      const rows = s.payload?.data ?? [];
      for (const r of rows) {
        const person = String(r["Responsible Person"] ?? r["Responsibility"] ?? r["approvers name"] ?? "").trim();
        if (person && person.toLowerCase() !== "unassigned") persons.add(person);
        const dept = String(r["Department"] ?? r["Vertical"] ?? r["Team"] ?? s.payload?.department ?? "").trim();
        if (dept) depts.add(dept);
      }
    }
    return {
      persons: Array.from(persons).sort((a, b) => a.localeCompare(b)),
      depts: Array.from(depts).sort((a, b) => a.localeCompare(b)),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queries.map(q => q.dataUpdatedAt).join(",")]);

  // Personal efficiency (regular user view) — derived from `d.persons` matched
  // to the signed-in user via nameNeedles.
  const myPerf = useMemo(() => {
    if (scope.isAdmin) return null;
    if (!scope.nameNeedles.length) return null;
    const mine = d.persons.find((p) => {
      const hay = `${p.person} ${p.email}`.toLowerCase();
      return scope.nameNeedles.some((n) => hay.includes(n));
    });
    return mine ?? null;
  }, [d.persons, scope.isAdmin, scope.nameNeedles]);



  const refetchAll = () => { registryQ.refetch(); queries.forEach(q => q.refetch()); };


  // AI Executive Brief
  const [brief, setBrief] = useState("");
  const briefMut = useMutation({
    mutationFn: async () => {
      const facts = {
        project: payload?.project,
        activities: d.n,
        health: d.healthScore,
        completion_pct: d.completionRate,
        on_time_pct: d.onTimeRate,
        delayed: d.totals.delayed, avg_delay_days: d.avgDelay,
        pace_ratio_pct: d.paceRatio,
        projected_days_to_finish: d.projectedDaysToFinish,
        worst_stage: d.stages[0]?.stage,
        top_overdue: d.overdue.slice(0, 4).map(o => ({ activity: o.activity, person: o.person, delay: o.delay })),
        highest_risk_person: d.personsByBurden[0] && { person: d.personsByBurden[0].person, delayed: d.personsByBurden[0].delayed, total: d.personsByBurden[0].total },
      };
      const res = await genFn({
        data: {
          system: "You are an operations chief-of-staff. Use ONLY the FACTS. Reply with 3 crisp sentences: (1) current state in one line, (2) the single biggest risk, (3) the one move worth making this week. No hedging, no invented numbers, no bullet points.",
          prompt: `FACTS:\n${JSON.stringify(facts, null, 2)}`,
          temperature: 0.2,
        },
      });
      return res.text;
    },
    onSuccess: (t) => setBrief(t),
  });

  useEffect(() => { setBrief(""); }, [payload]);
  useEffect(() => {
    if (payload && !brief && !briefMut.isPending) briefMut.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);

  // Ask Agent — grounded chat with history + retrieval over raw rows
  type ChatMsg = { role: "user" | "assistant"; text: string };
  const [question, setQuestion] = useState("");
  const [chat, setChat] = useState<ChatMsg[]>([]);
  useEffect(() => { setChat([]); }, [payload]);

  const rowsAll: Row[] = payload?.data ?? [];
  // Build a compact, LLM-friendly row projection with the columns we care about.
  const rowIndex = useMemo(() => rowsAll.map((r, i) => {
    const activity = pick(r, "Activity List", "Process Descriptions", "Process");
    const person = pick(r, "Responsible Person", "Responsibility", "approvers name");
    const email = pick(r, "Responsible Person Mail ID", "approvers email id");
    const stage = pick(r, "Stages", "Stages of Process");
    const status = pick(r, "Status Category", "Status as on Date");
    const crit = pick(r, "Criticality");
    const proj = pick(r, "__project");
    const tat = num(r["TAT"]);
    const taken = num(r["Days Taken"]);
    const delay = num(r["Delay in Days"]);
    const hay = [activity, person, email, stage, status, crit, proj].join(" ").toLowerCase();
    return { i, activity, person, email, stage, status, crit, proj, tat, taken, delay, hay };
  }), [rowsAll]);

  // Build a directory of every unique person that appears in the data so we
  // can detect when a question is about a specific manager / owner even when
  // it is only a first-name or an email fragment.
  const personDirectory = useMemo(() => {
    const seen = new Map<string, { name: string; email: string; tokens: string[] }>();
    for (const r of rowIndex) {
      const name = String(r.person ?? "");
      const email = String(r.email ?? "");
      const key = (name || email).toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      const tokens = [
        ...name.toLowerCase().split(/[^a-z0-9]+/).filter((t: string) => t.length > 2),
        ...email.toLowerCase().split(/[^a-z0-9]+/).filter((t: string) => t.length > 2),
      ];
      seen.set(key, { name, email, tokens });
    }
    return Array.from(seen.values());
  }, [rowIndex]);

  /** Find every person mentioned by name or email fragment inside a question. */
  function detectPersons(q: string) {
    const ql = q.toLowerCase();
    return personDirectory.filter(p => p.tokens.some(t => ql.includes(t))).slice(0, 5);
  }

  function retrieveRows(q: string, limit = 30, focusPersons: { name: string; email: string }[] = []) {
    const terms = q.toLowerCase().split(/[^a-z0-9@._-]+/).filter(t => t.length > 2);
    const scored = rowIndex.map(r => {
      let s = 0;
      for (const t of terms) if (r.hay.includes(t)) s += 1;
      // Big boost when the row belongs to a person the question is asking about.
      for (const p of focusPersons) {
        const hay = `${r.person} ${r.email}`.toLowerCase();
        if (p.name && hay.includes(p.name.toLowerCase())) s += 5;
        else if (p.email && hay.includes(p.email.toLowerCase())) s += 5;
      }
      if (/overdue|delay|late|breach/.test(q) && r.delay > 0) s += 0.5;
      if (/complete|done/.test(q) && /complete|done/i.test(r.status)) s += 0.5;
      return { r, s };
    }).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit);
    if (scored.length) return scored.map(x => x.r);
    if (focusPersons.length) {
      // Fallback: any row belonging to the focus person, even if no term matched.
      const fallback = rowIndex.filter(r => {
        const hay = `${r.person} ${r.email}`.toLowerCase();
        return focusPersons.some(p => (p.name && hay.includes(p.name.toLowerCase())) || (p.email && hay.includes(p.email.toLowerCase())));
      }).slice(0, limit);
      if (fallback.length) return fallback;
    }
    return rowIndex.slice(0, limit);
  }

  const askMut = useMutation({
    mutationFn: async (q: string) => {
      const isSelfQ = /\b(my|mine|me|i)\b/i.test(q);
      const focusPersons = detectPersons(q);
      let pool = rowIndex;
      if (isSelfQ && scope.nameNeedles.length) {
        const mine = rowIndex.filter((r) => {
          const hay = `${r.person} ${r.email}`.toLowerCase();
          return scope.nameNeedles.some((n) => hay.includes(n));
        });
        if (mine.length) pool = mine;
      }
      const matches = (isSelfQ ? pool.slice(0, 30) : retrieveRows(q, 30, focusPersons))
        .map(r => ({
          activity: r.activity, person: r.person, email: r.email,
          stage: r.stage, status: r.status, criticality: r.crit,
          project: r.proj, tat: r.tat, taken: r.taken, delay: r.delay,
        }));

      // Person-specific rollups so the model can answer "why is X delayed"
      // without having to re-aggregate the raw rows itself.
      const personRollups = (focusPersons.length ? focusPersons : []).map(fp => {
        const owned = rowIndex.filter(r => {
          const hay = `${String(r.person ?? "")} ${String(r.email ?? "")}`.toLowerCase();
          return (fp.name && hay.includes(fp.name.toLowerCase())) || (fp.email && hay.includes(fp.email.toLowerCase()));
        });
        const overdue = owned.filter(r => r.delay > 0);
        const done = owned.filter(r => /complete|done/i.test(String(r.status ?? "")));
        const byProj: Record<string, number> = {};
        const byStage: Record<string, number> = {};
        for (const r of owned) {
          const p = String(r.proj ?? "");
          const s = String(r.stage ?? "");
          if (p) byProj[p] = (byProj[p] ?? 0) + 1;
          if (s) byStage[s] = (byStage[s] ?? 0) + 1;
        }
        const avgDelay = overdue.length
          ? Math.round((overdue.reduce((s, r) => s + r.delay, 0) / overdue.length) * 10) / 10
          : 0;
        return {
          person: fp.name || fp.email,
          email: fp.email,
          total_activities: owned.length,
          overdue: overdue.length,
          completed: done.length,
          avg_delay_days_when_overdue: avgDelay,
          projects: byProj,
          stages: byStage,
          worst_activities: overdue
            .sort((a, b) => b.delay - a.delay)
            .slice(0, 5)
            .map(r => ({ activity: r.activity, stage: r.stage, project: r.proj, delay_days: r.delay, status: r.status })),
        };
      });

      const you = {
        name: scope.profile?.full_name || "(unknown)",
        email: scope.profile?.email || "(unknown)",
        role: scope.isSuper ? "super_admin (MD / Vertical Head)" : scope.isAdmin ? "admin (Reporting Manager)" : "user",
        assigned_projects: scope.assignments.map((a) => a.project_label),
      };
      const facts = {
        project: payload?.project,
        totals: d.totals, health: d.healthScore, completion_pct: d.completionRate,
        on_time_pct: d.onTimeRate, avg_delay_days: d.avgDelay, pace_pct_of_tat: d.paceRatio,
        stages: d.stages,
        persons: d.personsByBurden.slice(0, 20),
        overdue_top: d.overdue.slice(0, 15),
        anomalies: d.anomalies,
        status_mix: d.status, criticality_mix: d.critAgg,
      };
      const history = chat.slice(-6).map(m => `${m.role === "user" ? "USER" : "AGENT"}: ${m.text}`).join("\n");
      // Compact human label describing exactly which slice of data the answer
      // is grounded on. Regular users see personal scope; admins see the
      // project + focus filters currently applied on the dashboard.
      const scopeLabel = (() => {
        const parts: string[] = [];
        if (!scope.isAdmin) {
          parts.push(`personal · ${scope.profile?.full_name || scope.profile?.email || "you"}`);
        } else if (scope.isSuper) {
          parts.push("super_admin · all projects");
        } else {
          parts.push(`admin · ${scope.assignments.length} assigned project${scope.assignments.length === 1 ? "" : "s"}`);
        }
        if (selected !== "all") {
          const proj = sources.find(s => s.project.id === selected)?.project.label;
          if (proj) parts.push(`project=${proj}`);
        }
        if (canFocus && focusPerson !== "all") parts.push(`person=${focusPerson}`);
        if (canFocus && focusDept !== "all") parts.push(`team=${focusDept}`);
        parts.push(`${rowsAll.length} rows in scope`);
        return parts.join(" · ");
      })();
      const res = await genFn({
        data: {
          system: "You are the user's personal project agent. Answers MUST be strictly grounded in the SCOPED_DATA provided below — never invent people, projects, activities, or numbers, and never reach outside the scope. Answers must be PERSON-CONCENTRATED: whenever the question is about a specific person, or a specific reason for delay, name the person(s) explicitly by full name and cite their exact activities, stages, projects, delay-days, and status from MATCHING_ROWS or PERSON_ROLLUPS. Never conflate people. If the user says 'me / my / mine', treat that as YOU.name / YOU.email. If the answer isn't in SCOPED_DATA, say 'not in the current scope' and suggest widening the filter. ALWAYS end your reply with a single short italic line beginning with 'Scope:' that repeats SCOPE_LABEL verbatim. Prefer 2-6 sentences; short bullets for per-person lists or steps.",
          prompt: `SCOPE_LABEL: ${scopeLabel}\n\nYOU:\n${JSON.stringify(you)}\n\nFACTS (aggregates over SCOPED_DATA):\n${JSON.stringify(facts)}\n\nPERSON_ROLLUPS (focused on people mentioned in the question, computed over SCOPED_DATA):\n${JSON.stringify(personRollups)}\n\nMATCHING_ROWS (top-ranked for this question, out of ${rowsAll.length} in-scope rows${isSelfQ ? ", filtered to YOU when possible" : focusPersons.length ? `, boosted for ${focusPersons.map(p => p.name || p.email).join(", ")}` : ""}):\n${JSON.stringify(matches)}\n\nCONVERSATION_SO_FAR:\n${history || "(none)"}\n\nQUESTION: ${q}`,
          temperature: 0.15,
        },
      });

      return res.text;
    },
    onSuccess: (t, q) => setChat(prev => [...prev, { role: "user", text: q }, { role: "assistant", text: t }]),
  });

  function ask(q: string) {
    const t = q.trim();
    if (!t) return;
    setQuestion("");
    askMut.mutate(t);
  }

  // ── FILTERED REPORT / EXPORT
  type Filters = { status: string; crit: string; stage: string; person: string; minDelay: string; q: string; onlyOverdue: boolean };
  const filterKey = `agent:filters:${selected}`;
  const [filters, setFilters] = useState<Filters>(() => {
    if (typeof window === "undefined") return { status: "all", crit: "all", stage: "all", person: "all", minDelay: "", q: "", onlyOverdue: false };
    try {
      const raw = sessionStorage.getItem(filterKey);
      if (raw) return JSON.parse(raw) as Filters;
    } catch { /* noop */ }
    return { status: "all", crit: "all", stage: "all", person: "all", minDelay: "", q: "", onlyOverdue: false };
  });
  useEffect(() => {
    if (typeof window !== "undefined") sessionStorage.setItem(filterKey, JSON.stringify(filters));
  }, [filterKey, filters]);
  // Reset filters when the underlying project payload changes identity.
  useEffect(() => {
    const raw = typeof window !== "undefined" ? sessionStorage.getItem(filterKey) : null;
    if (!raw) setFilters({ status: "all", crit: "all", stage: "all", person: "all", minDelay: "", q: "", onlyOverdue: false });
  }, [payload?.project, filterKey]);

  const filterOptions = useMemo(() => {
    const s = new Set<string>(), c = new Set<string>(), st = new Set<string>(), p = new Set<string>();
    for (const r of rowIndex) {
      if (r.status) s.add(bucket(r.status));
      if (r.crit) c.add(r.crit);
      if (r.stage) st.add(r.stage);
      if (r.person) p.add(r.person);
    }
    return {
      status: Array.from(s).sort(),
      crit: Array.from(c).sort(),
      stage: Array.from(st).sort(),
      person: Array.from(p).sort(),
    };
  }, [rowIndex]);

  const filteredRows = useMemo(() => {
    const min = Number(filters.minDelay) || 0;
    const q = filters.q.trim().toLowerCase();
    return rowIndex.filter(r => {
      if (filters.status !== "all" && bucket(r.status) !== filters.status) return false;
      if (filters.crit !== "all" && r.crit !== filters.crit) return false;
      if (filters.stage !== "all" && r.stage !== filters.stage) return false;
      if (filters.person !== "all" && r.person !== filters.person) return false;
      if (min > 0 && r.delay < min) return false;
      if (filters.onlyOverdue && !(r.delay > 0 && !/complete|done/i.test(r.status))) return false;
      if (q && !r.hay.includes(q)) return false;
      return true;
    });
  }, [rowIndex, filters]);

  function downloadCSV() {
    const cols = ["project", "activity", "person", "email", "stage", "status", "criticality", "tat", "taken", "delay"];
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(",")];
    for (const r of filteredRows) {
      lines.push([r.proj, r.activity, r.person, r.email, r.stage, r.status, r.crit, r.tat, r.taken, r.delay].map(esc).join(","));
    }
    const meta = `# Filtered report · ${payload?.project ?? "project"} · ${filteredRows.length}/${rowIndex.length} rows · generated ${new Date().toISOString()}\n`;
    const blob = new Blob([meta + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safe = (payload?.project ?? "report").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    a.download = `${safe}-filtered-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  // ─── EXPORT SCOPED DATA ─────────────────────────────────────────────────────
  // Exports the currently active view — i.e. the rows the user is looking at
  // after applying the dashboard search + filter controls, not just the full
  // in-scope dataset. Every export is stamped with the exact scope
  // (person/team/project), the applied filters, timezone, data window, and
  // both counts (filtered vs. total in-scope).
  function scopeSummary() {
    const parts: string[] = [];
    if (!scope.isAdmin) parts.push(`Personal · ${scope.profile?.full_name || scope.profile?.email || "you"}`);
    else if (scope.isSuper) parts.push("Super admin · all projects");
    else parts.push(`Admin · ${scope.assignments.length} assigned project(s)`);
    if (selected !== "all") {
      const proj = sources.find(s => s.project.id === selected)?.project.label;
      if (proj) parts.push(`Project: ${proj}`);
    } else parts.push("Project: All");
    if (canFocus && focusPerson !== "all") parts.push(`Person: ${focusPerson}`);
    if (canFocus && focusDept !== "all") parts.push(`Team: ${focusDept}`);
    return parts.join(" · ");
  }

  function activeFilterSummary() {
    const parts: string[] = [];
    if (filters.q.trim()) parts.push(`search="${filters.q.trim()}"`);
    if (filters.status !== "all") parts.push(`status=${filters.status}`);
    if (filters.crit !== "all") parts.push(`criticality=${filters.crit}`);
    if (filters.stage !== "all") parts.push(`stage=${filters.stage}`);
    if (filters.person !== "all") parts.push(`person=${filters.person}`);
    if (Number(filters.minDelay) > 0) parts.push(`min-delay≥${filters.minDelay}d`);
    if (filters.onlyOverdue) parts.push("only-overdue");
    return parts.length ? parts.join(" · ") : "none";
  }

  function dataWindow() {
    const stamps = sources
      .map((s) => s.payload?.generated_at)
      .filter((v): v is string => !!v)
      .map((v) => new Date(v).getTime())
      .filter((n) => Number.isFinite(n));
    if (!stamps.length) return { from: null as string | null, to: null as string | null };
    return {
      from: new Date(Math.min(...stamps)).toISOString(),
      to: new Date(Math.max(...stamps)).toISOString(),
    };
  }

  function exportScopedCSV() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const win = dataWindow();
    const rows = filteredRows;
    const kpiLines = [
      "# Scope," + JSON.stringify(scopeSummary()),
      "# Applied filters," + JSON.stringify(activeFilterSummary()),
      "# Generated at," + new Date().toISOString(),
      "# Timezone," + tz,
      "# Data window from," + (win.from ?? "n/a"),
      "# Data window to," + (win.to ?? "n/a"),
      "# Rows exported," + rows.length,
      "# Rows in scope (unfiltered)," + rowIndex.length,
      "",
      "KPI,Value",
      `Activities,${d.n}`,
      `Health score,${d.healthScore}`,
      `Completion %,${d.completionRate}`,
      `On-time %,${d.onTimeRate}`,
      `Avg delay (days),${d.avgDelay}`,
      `Pace (% of TAT),${d.paceRatio}`,
      `Overdue count,${d.overdue.length}`,
      "",
      "Project,Activity,Person,Email,Stage,Status,Criticality,TAT,Days Taken,Delay Days",
    ];
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    for (const r of rows) {
      kpiLines.push([r.proj, r.activity, r.person, r.email, r.stage, r.status, r.crit, r.tat, r.taken, r.delay].map(esc).join(","));
    }
    const blob = new Blob([kpiLines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safe = (payload?.project ?? "scope").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    a.download = `${safe}-scoped-${rows.length}of${rowIndex.length}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  async function exportScopedPDF() {
    const { default: JsPDF } = await import("jspdf");
    const doc = new JsPDF({ unit: "pt", format: "a4" });
    const margin = 40;
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const win = dataWindow();
    const rows = filteredRows;
    let y = margin;

    doc.setFont("helvetica", "bold"); doc.setFontSize(16);
    doc.text("Scoped agent report", margin, y); y += 20;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9);
    doc.setTextColor(90);
    const stampLines = [
      `Scope: ${scopeSummary()}`,
      `Applied filters: ${activeFilterSummary()}`,
      `Generated: ${new Date().toLocaleString()} (${tz})`,
      `Data window: ${win.from ? new Date(win.from).toLocaleString() : "n/a"} → ${win.to ? new Date(win.to).toLocaleString() : "n/a"}`,
      `Records: ${rows.length} exported of ${rowIndex.length} in scope`,
    ];
    for (const line of stampLines) {
      const wrapped = doc.splitTextToSize(line, pageW - margin * 2);
      doc.text(wrapped, margin, y); y += wrapped.length * 12;
    }
    y += 4;
    doc.setTextColor(0);

    doc.setFont("helvetica", "bold"); doc.setFontSize(11);
    doc.text("Key metrics", margin, y); y += 14;
    doc.setFont("helvetica", "normal"); doc.setFontSize(10);
    const kpis: Array<[string, string]> = [
      ["Activities", String(d.n)],
      ["Health score", `${d.healthScore} / 100`],
      ["Completion", `${d.completionRate}%`],
      ["On-time", `${d.onTimeRate}%`],
      ["Avg delay", `${d.avgDelay} d`],
      ["Pace vs TAT", `${d.paceRatio}%`],
      ["Overdue", String(d.overdue.length)],
    ];
    const colW = (pageW - margin * 2) / 2;
    kpis.forEach((k, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = margin + col * colW;
      const yy = y + row * 14;
      doc.setTextColor(110); doc.text(k[0], x, yy);
      doc.setTextColor(0); doc.text(k[1], x + 110, yy);
    });
    y += Math.ceil(kpis.length / 2) * 14 + 10;

    doc.setFont("helvetica", "bold"); doc.setFontSize(11);
    doc.text(`Activities in view (${rows.length})`, margin, y); y += 12;
    doc.setFont("helvetica", "bold"); doc.setFontSize(8);
    const headers = ["Project", "Activity", "Person", "Stage", "Status", "Delay"];
    const widths = [80, 150, 90, 80, 70, 45];
    let x = margin;
    headers.forEach((h, i) => { doc.text(h, x, y); x += widths[i]; });
    y += 4; doc.setDrawColor(200); doc.line(margin, y, pageW - margin, y); y += 10;
    doc.setFont("helvetica", "normal"); doc.setFontSize(8);
    const clip = (s: string, w: number) => {
      const line = doc.splitTextToSize(s || "-", w - 4);
      return String(line[0] ?? "");
    };
    for (const r of rows) {
      if (y > pageH - margin) { doc.addPage(); y = margin; }
      x = margin;
      const cells = [r.proj, r.activity, r.person, r.stage, r.status, `${r.delay}d`];
      cells.forEach((c, i) => { doc.text(clip(String(c ?? ""), widths[i]), x, y); x += widths[i]; });
      y += 11;
    }
    const safe = (payload?.project ?? "scope").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    doc.save(`${safe}-scoped-${rows.length}of${rowIndex.length}-${new Date().toISOString().slice(0, 10)}.pdf`);
  }




  // Programmatic navigation is still used for row-click table handlers below.
  const nav = useNavigate();


  return (
    <div className="space-y-6">
      {/* HERO */}
      <div className="relative overflow-hidden rounded-3xl border border-border/60 bg-gradient-to-br from-indigo-500/10 via-fuchsia-500/5 to-transparent p-6">
        <div className="absolute -right-16 -top-16 h-56 w-56 rounded-full bg-gradient-to-br from-indigo-500/20 to-fuchsia-500/10 blur-3xl" />
        <div className="relative flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-primary">
              <Bot className="h-3 w-3" /> Autonomous Agent
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight md:text-3xl">
              {payload?.project ?? "Delay Bridge — Agentic View"}
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {scope.isSuper
                ? `Auto-syncs ${projects.length} live source${projects.length === 1 ? "" : "s"} every ${Math.round(AUTO_REFRESH_MS / 1000)}s${registryLive ? " · project list pulled from master sheet" : " · using built-in list"}.`
                : scope.isAdmin
                ? `Showing your ${projects.length} led project${projects.length === 1 ? "" : "s"} · syncing every ${Math.round(AUTO_REFRESH_MS / 1000)}s.`
                : `Showing only work assigned to ${scope.profile?.full_name || "you"} across your ${projects.length} project${projects.length === 1 ? "" : "s"}.`}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Badge variant="outline" className="gap-1">
                <Layers className="h-3 w-3" />
                {payload?.data?.length ?? 0} rows
              </Badge>
              {!scope.isSuper && (
                <ProjectAssignmentPicker
                  projects={allProjects}
                  current={assignedKeys}
                />
              )}
              <Button variant="outline" size="sm" onClick={refetchAll}>
                <RefreshCw className={`h-4 w-4 ${anyFetching ? "animate-spin" : ""}`} />
                Sync
              </Button>
              <div className="inline-flex overflow-hidden rounded-md border border-border/60">
                <Button
                  variant="ghost" size="sm"
                  className="h-8 gap-1 rounded-none px-2.5 text-xs"
                  onClick={exportScopedCSV}
                  disabled={!payload || filteredRows.length === 0}
                  aria-label="Export current filtered view as CSV"
                  title={`Export ${filteredRows.length} of ${rowIndex.length} rows (current filters) as CSV`}
                >
                  <Download className="h-3.5 w-3.5" /> CSV
                </Button>
                <div className="w-px bg-border/60" aria-hidden />
                <Button
                  variant="ghost" size="sm"
                  className="h-8 gap-1 rounded-none px-2.5 text-xs"
                  onClick={exportScopedPDF}
                  disabled={!payload || filteredRows.length === 0}
                  aria-label="Export current filtered view as PDF"
                  title={`Export KPIs + ${filteredRows.length} of ${rowIndex.length} rows (current filters) as PDF`}
                >
                  <Download className="h-3.5 w-3.5" /> PDF
                </Button>
              </div>


            </div>
            {lastSyncedAt && (
              <div className="text-[10px] text-muted-foreground">
                Data as of {new Date(lastSyncedAt).toLocaleString()}
              </div>
            )}
          </div>
        </div>
      </div>

      {needsOnboarding && (
        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="flex flex-col items-start gap-3 p-5 md:flex-row md:items-center">
            <div className="grid h-10 w-10 place-items-center rounded-full bg-primary/10 text-primary">
              <FolderKanban className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <div className="text-sm font-semibold">Pick your projects to get started</div>
              <p className="text-xs text-muted-foreground">
                Your dashboard, tasks, and Ask-the-Agent will focus on the projects you select.
              </p>
            </div>
            <ProjectAssignmentPicker
              projects={allProjects}
              current={assignedKeys}
              trigger={<Button size="sm">Select projects</Button>}
            />
          </CardContent>
        </Card>
      )}

      {/* PROJECT SWITCHER */}
      <div className="flex flex-wrap items-center gap-1.5">
        <ProjectChip
          label="All merged" active={selected === "all"}
          count={sources.reduce((a, s) => a + (s.payload?.data?.length ?? 0), 0)}
          loading={anyFetching && selected === "all"}
          onClick={() => setSelected("all")}
        />
        {sources.map(s => (
          <ProjectChip
            key={s.project.id}
            label={s.payload?.connector?.replace(" — view", "") || s.project.label}
            active={selected === s.project.id}
            count={s.payload?.data?.length ?? 0}
            loading={s.isFetching}
            error={s.isError}
            onClick={() => setSelected(s.project.id)}
          />
        ))}
        {selected !== "all" && (
          <Link
            to="/agent/project/$projectId"
            params={{ projectId: selected }}
            className="ml-1 rounded-full border border-primary/40 bg-primary/5 px-2.5 py-1 text-[11px] font-semibold text-primary hover:bg-primary/10"
            title="Open full project workspace"
          >Open workspace →</Link>
        )}
      </div>

      {anyLoading && !payload && (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading live data…
        </div>
      )}

      {allError && !payload && (
        <Card className="border-rose-500/40">
          <CardContent className="flex items-center gap-2 p-4 text-sm text-rose-600">
            <AlertTriangle className="h-4 w-4" /> Couldn't load any source. Retry Sync.
          </CardContent>
        </Card>
      )}


      {/* ADMIN / SUPER FOCUS BAR — filter the whole dashboard by person or team */}
      {canFocus && payload && (
        <Card className="border-primary/30 bg-primary/[0.03]">
          <CardContent className="flex flex-col gap-3 p-3 md:flex-row md:items-center md:gap-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
              <Filter className="h-3.5 w-3.5 text-primary" aria-hidden />
              <span className="uppercase tracking-wider">Focus</span>
            </div>
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5">
                <UserIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                <Select value={focusPerson} onValueChange={setFocusPerson}>
                  <SelectTrigger className="h-8 w-[200px] text-xs" aria-label="Focus by person">
                    <SelectValue placeholder="All people" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All people ({focusOptions.persons.length})</SelectItem>
                    {focusOptions.persons.map((p) => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {focusOptions.depts.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  <Select value={focusDept} onValueChange={setFocusDept}>
                    <SelectTrigger className="h-8 w-[180px] text-xs" aria-label="Focus by team or department">
                      <SelectValue placeholder="All teams" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All teams</SelectItem>
                      {focusOptions.depts.map((d) => (
                        <SelectItem key={d} value={d}>{d}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {(focusPerson !== "all" || focusDept !== "all") && (
                <>
                  <Badge variant="secondary" className="text-[10px]">
                    {payload.data?.length ?? 0} rows in focus
                  </Badge>
                  <Button
                    size="sm" variant="ghost" className="h-7 px-2 text-xs"
                    onClick={() => { setFocusPerson("all"); setFocusDept("all"); }}
                  >Clear</Button>
                </>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground md:ml-auto">
              KPIs, health, efficiency, and the brief all recompute from the focus.
            </div>
          </CardContent>
        </Card>
      )}

      {/* PERSONAL EFFICIENCY — regular users only */}
      {!scope.isAdmin && payload && myPerf && (
        <Card className="border-emerald-500/30 bg-gradient-to-br from-emerald-500/[0.08] to-transparent">
          <CardContent className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-5">
            <div className="col-span-2 flex items-center gap-3 sm:col-span-1">
              <div className="grid h-11 w-11 place-items-center rounded-full bg-emerald-500/15 text-emerald-700">
                <Zap className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-widest text-emerald-700/80">Your efficiency</div>
                <div className="truncate text-sm font-semibold" title={myPerf.person}>{myPerf.person}</div>
              </div>
            </div>
            <MiniStat label="Efficiency" value={`${myPerf.efficiency}`} sub="/ 100" tone={myPerf.efficiency >= 70 ? "ok" : myPerf.efficiency >= 40 ? "med" : "high"} />
            <MiniStat label="On-time" value={`${Math.max(0, 100 - myPerf.riskScore)}%`} tone={myPerf.riskScore <= 20 ? "ok" : "med"} />
            <MiniStat label="Activities" value={String(myPerf.total)} sub={`${myPerf.completed} done`} />
            <MiniStat label="Delayed" value={String(myPerf.delayed)} sub={`${myPerf.delayDays}d total`} tone={myPerf.delayed > 0 ? "high" : "ok"} />
          </CardContent>
          <div className="border-t border-emerald-500/20 bg-emerald-500/[0.04] px-4 py-2 text-[10.5px] leading-relaxed text-emerald-900/80">
            <span className="font-semibold uppercase tracking-widest text-emerald-700/90">Formula ·</span>{" "}
            Efficiency = 0.5 × Completion% + 0.5 × On-time% − 0.3 × max(0, Pace−100),
            where <b>On-time%</b> = 100 − (delayed ÷ total × 100),
            <b> Pace</b> = Days Taken ÷ TAT × 100, and <b>Delay days</b> sums <i>Delay in Days</i> across your rows.
            Computed from <b>{myPerf.total}</b> activities scoped to <b>{scope.profile?.full_name || scope.profile?.email || "you"}</b>.
          </div>
        </Card>
      )}


      {payload && (
        <>

          {/* AI BRIEF + HEALTH RING */}
          <div className="grid gap-4 md:grid-cols-3">
            <Card className="md:col-span-2 overflow-hidden border-primary/30 bg-gradient-to-br from-primary/[0.06] to-transparent">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Sparkles className="h-4 w-4 text-primary" /> Executive brief
                  {briefMut.isPending && <Loader2 className="ml-1 h-3 w-3 animate-spin text-muted-foreground" />}
                  <Button
                    variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs"
                    onClick={() => briefMut.mutate()} disabled={briefMut.isPending}
                  >
                    Regenerate
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {brief ? (
                  <p className="text-[15px] leading-relaxed text-foreground/90">{brief}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">Analyzing facts…</p>
                )}
              </CardContent>
            </Card>

            <Link
              to="/agent/kpi/$id"
              params={{ id: "health" }}
              className="block"
            >
              <Card className="overflow-hidden transition hover:shadow-md">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Gauge className="h-4 w-4 text-primary" /> Project health
                    <ArrowRight className="ml-auto h-3.5 w-3.5 opacity-40" />
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex items-center gap-3 pb-4">
                  <div className="h-32 w-32 shrink-0">
                    <ResponsiveContainer>
                      <RadialBarChart innerRadius="70%" outerRadius="100%" data={[{ name: "h", value: d.healthScore, fill: d.healthScore > 70 ? "#10b981" : d.healthScore > 40 ? "#f59e0b" : "#ef4444" }]} startAngle={90} endAngle={-270}>
                        <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
                        <RadialBar dataKey="value" cornerRadius={12} background={{ fill: "hsl(var(--muted))" }} />
                      </RadialBarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="min-w-0">
                    <div className="text-4xl font-semibold">{d.healthScore}</div>
                    <div className="text-xs text-muted-foreground">out of 100</div>
                    <div className="mt-2 space-y-0.5 text-[11px]">
                      <div>On-time <b>{d.onTimeRate}%</b></div>
                      <div>Completion <b>{d.completionRate}%</b></div>
                      <div>Pace <b>{d.paceRatio}%</b> of TAT</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          </div>

          {/* KPI STRIP */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <Kpi to={{ to: "/agent/kpi/$id", params: { id: "health" } }} icon={<Activity className="h-4 w-4" />} label="Activities" value={d.totals.total} />
            <Kpi to={{ to: "/agent/kpi/$id", params: { id: "ontime" } }} icon={<CheckCircle2 className="h-4 w-4" />} label="Completed" value={d.totals.completed} tone="ok" sub={`${d.completionRate}%`} />
            <Kpi to={{ to: "/agent/kpi/$id", params: { id: "overdue" } }} icon={<Clock className="h-4 w-4" />} label="Delayed" value={d.totals.delayed} tone={d.delayRate > 15 ? "high" : "med"} sub={`${d.delayRate}%`} />
            <Kpi to={{ to: "/agent/kpi/$id", params: { id: "tat" } }} icon={<Flame className="h-4 w-4" />} label="Avg delay" value={`${d.avgDelay}d`} tone={d.avgDelay > 30 ? "high" : "med"} />
            <Kpi to={{ to: "/agent/kpi/$id", params: { id: "overdue" } }} icon={<Target className="h-4 w-4" />} label="Not started" value={d.totals.notStarted} tone="low" />
            <Kpi to={{ to: "/agent/kpi/$id", params: { id: "risk" } }} icon={<TrendingUp className="h-4 w-4" />} label="ETA" value={d.projectedDaysToFinish ? `${d.projectedDaysToFinish}d` : "—"} sub="to finish" />
          </div>

          {/* NEXT BEST ACTIONS */}
          <Card className="overflow-hidden">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Zap className="h-4 w-4 text-amber-500" /> Next best actions
                <Badge variant="secondary" className="ml-2">{d.actions.length}</Badge>
                <span className="ml-auto text-[11px] font-normal text-muted-foreground">Ranked by impact</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 md:grid-cols-2">
              {d.actions.length === 0 && (
                <p className="text-sm text-muted-foreground">Nothing urgent. The agent will resurface work as data changes.</p>
              )}
              {d.actions.slice(0, 8).map(a => {
                // Route each action to its most specific detail page.
                // Prefer the row page when the action ties to one activity, else fall back to the person page.
                let to: "/agent/row/$key" | "/agent/person/$key";
                let params: { key: string };
                if (a.row) {
                  to = "/agent/row/$key";
                  params = {
                    key: encodeRowKey({
                      project: String((a.row as Row)["__project"] ?? payload?.project ?? ""),
                      srNo: String((a.row as Row)["Sr. No."] ?? (a.row as Row)["Sr No"] ?? (a.row as Row)["ID"] ?? ""),
                      activity: String(a.row["Activity List"] ?? a.row["Process Descriptions"] ?? a.row["Process"] ?? a.title ?? ""),
                    }),
                  };
                } else {
                  to = "/agent/person/$key";
                  params = { key: encodeEntityKey(a.person || a.title) };
                }
                return (
                  <Link
                    key={a.id}
                    to={to}
                    params={params}
                    className={`group block rounded-xl border p-3 transition hover:translate-y-[-1px] hover:shadow-md ${TONE[a.severity]}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[10px] font-bold uppercase tracking-widest opacity-70">{a.source}</div>
                        <div className="mt-0.5 text-sm font-semibold leading-tight">{a.title}</div>
                        <div className="mt-1 text-xs opacity-90">{a.detail}</div>
                        <div className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium opacity-80 group-hover:opacity-100">
                          Open source & take action <ArrowRight className="h-3 w-3" />
                        </div>
                      </div>
                      <Badge variant="outline" className="shrink-0 capitalize">{a.severity}</Badge>
                    </div>
                  </Link>
                );
              })}
            </CardContent>
          </Card>

          {/* ASK THE AGENT — grounded chat */}
          <Card className="border-primary/30">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Bot className="h-4 w-4 text-primary" /> Ask the agent
                <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                  Grounded on {rowsAll.length} rows · retrieval + facts
                </span>
                {chat.length > 0 && (
                  <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" onClick={() => setChat([])}>
                    Clear
                  </Button>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {chat.length > 0 && (
                <div className="max-h-80 space-y-2 overflow-y-auto rounded-lg border border-border/60 bg-muted/30 p-2">
                  {chat.map((m, i) => (
                    <div key={i} className={`flex gap-2 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                      {m.role === "assistant" && <Bot className="mt-1 h-4 w-4 shrink-0 text-primary" />}
                      <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                        m.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "border border-primary/20 bg-background"
                      }`}>{m.text}</div>
                      {m.role === "user" && <UserIcon className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />}
                    </div>
                  ))}
                  {askMut.isPending && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> thinking…
                    </div>
                  )}
                </div>
              )}
              <form
                onSubmit={(e) => { e.preventDefault(); ask(question); }}
                className="flex flex-col gap-2 md:flex-row"
              >
                <Input
                  value={question} onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Ask anything about this data — people, activities, delays, stages…"
                  className="flex-1"
                />
                <Button type="submit" disabled={askMut.isPending || !question.trim()}>
                  {askMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Ask
                </Button>
              </form>
              <div className="flex flex-wrap gap-1.5">
                {[
                  "What's the biggest bottleneck?",
                  "Who has the most overdue work and by how much?",
                  "List the 5 most critical activities to unblock this week.",
                  "Which stage is dragging the timeline and why?",
                  "Give me a 3-step recovery plan with owners.",
                ].map(sug => (
                  <button key={sug} type="button"
                    onClick={() => ask(sug)}
                    className="rounded-full border border-border/60 bg-background px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted"
                  >
                    {sug}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* FILTERED REPORT / EXPORT */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Filter className="h-4 w-4 text-primary" /> Filtered report
                <Badge variant="secondary" className="ml-2">{filteredRows.length} / {rowIndex.length}</Badge>
                <Button
                  size="sm" variant="outline" className="ml-auto h-8"
                  onClick={downloadCSV} disabled={filteredRows.length === 0}
                >
                  <Download className="h-4 w-4" /> Export CSV
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2 md:grid-cols-6">
                <Select value={filters.status} onValueChange={(v) => setFilters(f => ({ ...f, status: v }))}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Status" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    {filterOptions.status.map(x => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={filters.crit} onValueChange={(v) => setFilters(f => ({ ...f, crit: v }))}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Criticality" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All criticality</SelectItem>
                    {filterOptions.crit.map(x => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={filters.stage} onValueChange={(v) => setFilters(f => ({ ...f, stage: v }))}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Stage" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All stages</SelectItem>
                    {filterOptions.stage.map(x => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={filters.person} onValueChange={(v) => setFilters(f => ({ ...f, person: v }))}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Person" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All people</SelectItem>
                    {filterOptions.person.map(x => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Input
                  className="h-9 text-xs" placeholder="Min delay days" inputMode="numeric"
                  value={filters.minDelay} onChange={e => setFilters(f => ({ ...f, minDelay: e.target.value.replace(/[^\d]/g, "") }))}
                />
                <Input
                  className="h-9 text-xs" placeholder="Search text…"
                  value={filters.q} onChange={e => setFilters(f => ({ ...f, q: e.target.value }))}
                />
              </div>
              <div className="flex items-center gap-3 text-xs">
                <label className="inline-flex cursor-pointer items-center gap-1.5">
                  <input type="checkbox" checked={filters.onlyOverdue}
                    onChange={e => setFilters(f => ({ ...f, onlyOverdue: e.target.checked }))} />
                  Only overdue (not completed & delay &gt; 0)
                </label>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs ml-auto"
                  onClick={() => setFilters({ status: "all", crit: "all", stage: "all", person: "all", minDelay: "", q: "", onlyOverdue: false })}>
                  Reset filters
                </Button>
              </div>

              <div className="max-h-96 overflow-auto rounded-lg border border-border/60">
                <Table>
                  <TableHeader className="sticky top-0 bg-background">
                    <TableRow>
                      <TableHead>Activity</TableHead>
                      <TableHead>Person</TableHead>
                      <TableHead>Stage</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">TAT</TableHead>
                      <TableHead className="text-right">Taken</TableHead>
                      <TableHead className="text-right">Delay</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredRows.slice(0, 200).map(r => {
                      const src = rowsAll[r.i] as Row;
                      const rowKey = encodeRowKey({
                        project: String(src["__project"] ?? payload?.project ?? ""),
                        srNo: String(src["Sr. No."] ?? src["Sr No"] ?? src["ID"] ?? ""),
                        activity: r.activity || "",
                      });
                      const link = { to: "/agent/row/$key" as const, params: { key: rowKey } };
                      return (
                        <TableRow key={r.i} className="cursor-pointer hover:bg-muted/40" onClick={(e) => {
                          // Router-safe navigation via a hidden Link inside the row.
                          const a = e.currentTarget.querySelector<HTMLAnchorElement>("a[data-row-link]");
                          a?.click();
                        }}>
                          <TableCell className="max-w-[280px] truncate font-medium" title={r.activity}>
                            <Link {...link} data-row-link className="hover:underline">{r.activity || "—"}</Link>
                          </TableCell>
                          <TableCell className="text-xs">{r.person || "—"}</TableCell>
                          <TableCell className="text-xs">{r.stage || "—"}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={
                              /complete|done/i.test(r.status) ? TONE.ok :
                              /delay|late|overdue/i.test(r.status) ? TONE.high :
                              /progress/i.test(r.status) ? TONE.med : TONE.low
                            }>{r.status || "—"}</Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{r.tat || "—"}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.taken || "—"}</TableCell>
                          <TableCell className={`text-right tabular-nums ${r.delay > 0 ? "text-rose-600 font-semibold" : ""}`}>{r.delay || "—"}</TableCell>
                        </TableRow>
                      );
                    })}
                    {filteredRows.length === 0 && (
                      <TableRow><TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">No rows match.</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              {filteredRows.length > 200 && (
                <p className="text-[11px] text-muted-foreground">Showing first 200 rows. Export CSV to get all {filteredRows.length}.</p>
              )}
            </CardContent>
          </Card>


          {/* BOTTOM BENTO: bottlenecks · people · anomalies */}
          <div className="grid gap-4 md:grid-cols-3">
            {/* Bottlenecks */}
            <Card className="md:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Radar className="h-4 w-4 text-rose-500" /> Bottleneck map (stages)
                </CardTitle>
              </CardHeader>
              <CardContent className="h-72">
                <ResponsiveContainer>
                  <BarChart
                    data={d.stages.slice(0, 8)}
                    layout="vertical"
                    margin={{ left: 10, right: 10 }}
                    onClick={(e: { activeLabel?: string } | null) => {
                      const stage = e?.activeLabel;
                      if (!stage) return;
                      nav({ to: "/agent/stage/$key", params: { key: encodeEntityKey(stage) } });
                    }}
                  >
                    <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                    <XAxis type="number" fontSize={11} />
                    <YAxis
                      type="category" dataKey="stage" fontSize={11} width={130}
                      style={{ cursor: "pointer" }}
                    />
                    <Tooltip cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }} />
                    <Bar dataKey="delayDays" fill="#f43f5e" name="Delay days" radius={[0, 6, 6, 0]} style={{ cursor: "pointer" }} />
                    <Bar dataKey="delayed" fill="#f59e0b" name="Delayed items" radius={[0, 6, 6, 0]} style={{ cursor: "pointer" }} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Top performers */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Users className="h-4 w-4 text-emerald-500" /> Top performers
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {d.topPerformers.slice(0, 5).map((p, i) => (
                  <Link
                    key={p.person}
                    to="/agent/person/$key"
                    params={{ key: encodeEntityKey(p.person) }}
                    className="block"
                  >
                    <div className="rounded-lg border border-border/60 p-2.5 transition hover:bg-muted/40">
                      <div className="flex items-center gap-2">
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/10 text-xs font-bold text-emerald-700">{i + 1}</div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{p.person}</div>
                          <div className="text-[11px] text-muted-foreground">{p.completed}/{p.total} done</div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-semibold">{p.efficiency}</div>
                          <div className="text-[10px] text-muted-foreground">EFF</div>
                        </div>
                      </div>
                      <Progress value={p.efficiency} className="mt-1.5 h-1" />
                    </div>
                  </Link>
                ))}
                {d.topPerformers.length === 0 && <p className="text-xs text-muted-foreground">Not enough completions yet.</p>}
              </CardContent>
            </Card>
          </div>

          {/* PEOPLE TABLE */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Users className="h-4 w-4" /> Efficiency ranking
                <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                  Score = 0.5·completion + 0.5·on-time − pace penalty
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Person</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Done</TableHead>
                    <TableHead className="text-right">Delayed</TableHead>
                    <TableHead className="text-right">Delay·d</TableHead>
                    <TableHead className="w-40">Efficiency</TableHead>
                    <TableHead>Risk</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.personsByBurden.slice(0, 12).map(p => {
                    const to = { to: "/agent/person/$key" as const, params: { key: encodeEntityKey(p.person) } };
                    return (
                      <TableRow key={p.person} className="cursor-pointer hover:bg-muted/40" onClick={() => nav(to)}>
                        <TableCell className="font-medium">
                          <Link {...to} className="hover:underline">{p.person}</Link>
                        </TableCell>
                        <TableCell className="text-right">{p.total}</TableCell>
                        <TableCell className="text-right">{p.completed}</TableCell>
                        <TableCell className="text-right">{p.delayed}</TableCell>
                        <TableCell className="text-right">{p.delayDays}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Progress value={p.efficiency} className="h-1.5" />
                            <span className="w-8 text-xs text-muted-foreground">{p.efficiency}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={p.riskScore > 50 ? TONE.high : p.riskScore > 25 ? TONE.med : TONE.ok}>
                            {p.riskScore}%
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* OVERDUE + ANOMALIES */}
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <AlertTriangle className="h-4 w-4 text-rose-500" /> Overdue queue
                  <Badge variant="secondary" className="ml-auto">{d.overdue.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {d.overdue.slice(0, 8).map((o, i) => {
                  const rowKey = encodeRowKey({
                    project: String((o.row as Row)?.["__project"] ?? payload?.project ?? ""),
                    srNo: String((o.row as Row)?.["Sr. No."] ?? (o.row as Row)?.["Sr No"] ?? (o.row as Row)?.["ID"] ?? ""),
                    activity: o.activity || "",
                  });
                  const link = { to: "/agent/row/$key" as const, params: { key: rowKey } };
                  return (
                    <Link key={i} {...link} className="block">
                      <div className={`rounded-lg border p-2.5 transition hover:shadow-sm ${o.delay > 60 ? TONE.high : o.delay > 20 ? TONE.med : TONE.low}`}>
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold">{o.activity}</div>
                            <div className="mt-0.5 text-[11px] opacity-80">{o.person} · {o.stage}</div>
                          </div>
                          <div className="shrink-0 text-right">
                            <div className="text-sm font-bold">{o.delay}d</div>
                            <div className="text-[10px] opacity-70">TAT {o.tat} / took {o.taken}</div>
                          </div>
                        </div>
                      </div>
                    </Link>
                  );
                })}
                {d.overdue.length === 0 && <p className="text-xs text-muted-foreground">No overdue items.</p>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <ArrowRight className="h-4 w-4 text-fuchsia-500" /> Anomalies
                  <span className="ml-2 text-[11px] font-normal text-muted-foreground">taken ≥ 1.8× TAT</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {d.anomalies.map((a, i) => (
                  <Link
                    key={i}
                    to="/agent/stage/$key"
                    params={{ key: encodeEntityKey(a.stage) }}
                    className="block"
                  >
                    <div className="rounded-lg border border-border/60 p-2.5 transition hover:bg-muted/40">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{a.activity}</div>
                          <div className="text-[11px] text-muted-foreground">{a.person} · {a.stage}</div>
                        </div>
                        <Badge className="shrink-0 bg-fuchsia-500/10 text-fuchsia-700 border-fuchsia-500/30" variant="outline">
                          {a.ratio.toFixed(1)}×
                        </Badge>
                      </div>
                    </div>
                  </Link>
                ))}
                {d.anomalies.length === 0 && <p className="text-xs text-muted-foreground">No anomalies detected.</p>}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

// ────────────────── KPI ──────────────────
type KpiLink =
  | { to: "/agent/kpi/$id"; params: { id: string } }
  | { to: "/agent/row/$key"; params: { key: string } }
  | { to: "/agent/person/$key"; params: { key: string } }
  | { to: "/agent/stage/$key"; params: { key: string } }
  | { to: "/agent/project/$projectId"; params: { projectId: string } };

function MiniStat({ label, value, sub, tone = "default" }: {
  label: string; value: string; sub?: string;
  tone?: "default" | "ok" | "med" | "high";
}) {
  const cls =
    tone === "ok" ? "text-emerald-700" :
    tone === "med" ? "text-amber-700" :
    tone === "high" ? "text-rose-700" :
    "text-foreground";
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${cls}`}>
        {value}{sub && <span className="ml-1 text-[10px] font-normal text-muted-foreground">{sub}</span>}
      </div>
    </div>
  );
}

function Kpi({ icon, label, value, sub, tone = "default", to }: {
  icon: React.ReactNode; label: string; value: string | number; sub?: string;
  tone?: "default" | "ok" | "med" | "high" | "low";
  to?: KpiLink;
}) {
  const cls =
    tone === "ok" ? TONE.ok :
    tone === "med" ? TONE.med :
    tone === "high" ? TONE.high :
    tone === "low" ? TONE.low :
    "border-border/60 bg-card";
  const body = (
    <Card className={`border transition ${cls} ${to ? "cursor-pointer hover:shadow-md hover:-translate-y-0.5" : ""}`}>
      <CardContent className="p-3.5">
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest opacity-70">
          {icon}{label}
          {to && <ArrowRight className="ml-auto h-3 w-3 opacity-40" />}
        </div>
        <div className="mt-1 text-2xl font-semibold leading-none">{value}</div>
        {sub && <div className="mt-1 text-[11px] opacity-70">{sub}</div>}
      </CardContent>
    </Card>
  );
  if (!to) return body;
  // Discriminated Link so TS accepts every param shape.
  if (to.to === "/agent/kpi/$id")
    return <Link to={to.to} params={to.params} className="block">{body}</Link>;
  if (to.to === "/agent/row/$key")
    return <Link to={to.to} params={to.params} className="block">{body}</Link>;
  if (to.to === "/agent/person/$key")
    return <Link to={to.to} params={to.params} className="block">{body}</Link>;
  if (to.to === "/agent/stage/$key")
    return <Link to={to.to} params={to.params} className="block">{body}</Link>;
  return <Link to={to.to} params={to.params} className="block">{body}</Link>;
}

function ProjectChip({ label, count, active, loading, error, onClick }: {
  label: string; count: number; active: boolean;
  loading?: boolean; error?: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button" onClick={onClick}
      className={[
        "group inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition",
        active
          ? "border-primary/50 bg-primary/10 text-primary shadow-sm"
          : "border-border/60 bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground",
      ].join(" ")}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${error ? "bg-rose-500" : loading ? "bg-amber-400 animate-pulse" : "bg-emerald-500"}`} />
      {label}
      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
        {count}
      </span>
    </button>
  );
}


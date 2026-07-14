import { createFileRoute } from "@tanstack/react-router";
import { isHookAuthorized } from "@/lib/hook-auth.server";
import { createClient } from "@supabase/supabase-js";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type NewAlert = {
  flag_id: string;
  activity: string;
  severity: "low" | "medium" | "high";
  root_cause: string;
  reason: string;
  ref_key: string; // for smart_alert_state
  rule_kind: string;
};

export const Route = createFileRoute("/api/public/hooks/smart-alerts-scan")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isHookAuthorized(request)) return json({ error: "Unauthorized" }, 401);
        const admin = createClient(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false, autoRefreshToken: false } },
        );

        const now = new Date();
        const todayISO = now.toISOString().slice(0, 10);
        const in3Days = new Date(now); in3Days.setDate(in3Days.getDate() + 3);
        const in3ISO = in3Days.toISOString().slice(0, 10);
        const days14Ago = new Date(now); days14Ago.setDate(days14Ago.getDate() - 14);
        const days14ISO = days14Ago.toISOString();
        const dayAgo = new Date(now); dayAgo.setDate(dayAgo.getDate() - 1);
        const dayAgoISO = dayAgo.toISOString();

        // Pick a system sender = first super_admin
        const { data: supers } = await admin
          .from("user_roles").select("user_id").eq("role", "super_admin").limit(1);
        const sentBy = supers?.[0]?.user_id;
        if (!sentBy) return json({ ok: true, skipped: "no super_admin to attribute alerts" });

        const proposed: NewAlert[] = [];

        // 1) At-risk activities
        const { data: activities } = await admin
          .from("activities")
          .select("id, title, status, due_date, completed_at, project_id");
        for (const a of activities ?? []) {
          if (a.status === "completed") continue;
          const overdue = a.due_date && a.due_date < todayISO;
          const soon = a.due_date && a.due_date >= todayISO && a.due_date <= in3ISO && a.status === "not_started";
          if (overdue || soon) {
            proposed.push({
              flag_id: `smart:activity:${a.id}`,
              activity: a.title,
              severity: overdue ? "high" : "medium",
              root_cause: "Smart scan",
              reason: overdue ? `Overdue since ${a.due_date}` : `Due by ${a.due_date} and not started`,
              ref_key: `activity:${a.id}:${overdue ? "overdue" : "atrisk"}`,
              rule_kind: "at_risk_activity",
            });
          }
        }

        // 2) Silent projects
        const { data: projects } = await admin.from("projects").select("id, name");
        for (const p of projects ?? []) {
          const projActs = (activities ?? []).filter((a) => a.project_id === p.id);
          if (projActs.length === 0) continue;
          const latest = projActs.reduce((max, a) => {
            const d = a.completed_at ?? "";
            return d > max ? d : max;
          }, "");
          if (!latest || latest < days14ISO) {
            proposed.push({
              flag_id: `smart:silent:${p.id}`,
              activity: `Project "${p.name}" silent 14+ days`,
              severity: "medium",
              root_cause: "Smart scan",
              reason: "No activity updates in the last 14 days.",
              ref_key: `silent:${p.id}:${todayISO}`,
              rule_kind: "silent_project",
            });
          }
        }

        // 3) Sheet anomalies (numeric values > 2σ from column mean, sample per sheet)
        const { data: sheetRows } = await admin
          .from("sheet_rows")
          .select("sheet_registry_id, row_index, data")
          .limit(5000);
        const bySheet = new Map<string, Array<{ row_index: number; data: any }>>();
        for (const r of sheetRows ?? []) {
          const arr = bySheet.get(r.sheet_registry_id) ?? [];
          arr.push(r as any);
          bySheet.set(r.sheet_registry_id, arr);
        }
        for (const [sheetId, rows] of bySheet.entries()) {
          if (rows.length < 8) continue;
          // Collect numeric columns
          const numericCols = new Map<string, number[]>();
          for (const r of rows) {
            if (!r.data || typeof r.data !== "object") continue;
            for (const [k, v] of Object.entries(r.data)) {
              const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(/,/g, "")) : NaN;
              if (Number.isFinite(n)) {
                const arr = numericCols.get(k) ?? [];
                arr.push(n);
                numericCols.set(k, arr);
              }
            }
          }
          for (const [col, vals] of numericCols.entries()) {
            if (vals.length < 8) continue;
            const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
            const variance = vals.reduce((s, x) => s + (x - mean) ** 2, 0) / vals.length;
            const std = Math.sqrt(variance);
            if (std === 0) continue;
            // Flag the most extreme row only
            let extremeIdx = -1;
            let extremeZ = 2;
            let extremeVal = 0;
            for (const r of rows) {
              const raw = r.data?.[col];
              const n = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/,/g, ""));
              if (!Number.isFinite(n)) continue;
              const z = Math.abs((n - mean) / std);
              if (z > extremeZ) { extremeZ = z; extremeIdx = r.row_index; extremeVal = n; }
            }
            if (extremeIdx >= 0) {
              proposed.push({
                flag_id: `smart:anomaly:${sheetId}:${col}:${extremeIdx}`,
                activity: `Anomaly in "${col}" (row ${extremeIdx})`,
                severity: extremeZ > 3 ? "high" : "medium",
                root_cause: "Smart scan · sheet anomaly",
                reason: `Value ${extremeVal} is ${extremeZ.toFixed(1)}σ from column mean ${mean.toFixed(2)}.`,
                ref_key: `anomaly:${sheetId}:${col}`,
                rule_kind: "sheet_anomaly",
              });
            }
          }
        }

        // 4) Keyword watch (last 24h documents + sheet rows)
        const { data: rules } = await admin
          .from("smart_alert_rules").select("id, phrase, target, is_active").eq("is_active", true);
        if ((rules ?? []).length > 0) {
          const { data: recentDocs } = await admin
            .from("documents").select("id, name, summary").gte("created_at", dayAgoISO);
          const { data: recentRows } = await admin
            .from("sheet_rows").select("sheet_registry_id, row_index, data").gte("created_at", dayAgoISO).limit(2000);
          for (const rule of rules ?? []) {
            const needle = rule.phrase.toLowerCase();
            if (rule.target === "documents" || rule.target === "both") {
              for (const d of recentDocs ?? []) {
                const hay = `${d.name ?? ""} ${d.summary ?? ""}`.toLowerCase();
                if (hay.includes(needle)) {
                  proposed.push({
                    flag_id: `smart:kw:doc:${rule.id}:${d.id}`,
                    activity: `Keyword "${rule.phrase}" in document "${d.name}"`,
                    severity: "medium",
                    root_cause: "Smart scan · keyword watch",
                    reason: `Matched phrase "${rule.phrase}"`,
                    ref_key: `kw:doc:${rule.id}:${d.id}`,
                    rule_kind: "keyword",
                  });
                }
              }
            }
            if (rule.target === "sheet_rows" || rule.target === "both") {
              for (const r of recentRows ?? []) {
                const hay = JSON.stringify(r.data ?? {}).toLowerCase();
                if (hay.includes(needle)) {
                  proposed.push({
                    flag_id: `smart:kw:row:${rule.id}:${r.sheet_registry_id}:${r.row_index}`,
                    activity: `Keyword "${rule.phrase}" in sheet row ${r.row_index}`,
                    severity: "medium",
                    root_cause: "Smart scan · keyword watch",
                    reason: `Matched phrase "${rule.phrase}"`,
                    ref_key: `kw:row:${rule.id}:${r.sheet_registry_id}:${r.row_index}`,
                    rule_kind: "keyword",
                  });
                }
              }
            }
          }
        }

        // Deduplicate against smart_alert_state
        const refKeys = proposed.map((p) => p.ref_key);
        const { data: existingState } = await admin
          .from("smart_alert_state").select("rule_kind, ref_key").in("ref_key", refKeys.length ? refKeys : ["__none__"]);
        const already = new Set((existingState ?? []).map((s) => `${s.rule_kind}|${s.ref_key}`));
        const fresh = proposed.filter((p) => !already.has(`${p.rule_kind}|${p.ref_key}`));

        let inserted = 0;
        for (const p of fresh) {
          const { error } = await admin.from("alerts").insert({
            flag_id: p.flag_id,
            activity: p.activity,
            severity: p.severity,
            source: "smart_scan",
            root_cause: p.root_cause,
            reason: p.reason,
            status: "open",
            sent_by: sentBy,
          });
          if (!error) {
            inserted++;
            await admin.from("smart_alert_state").upsert(
              { rule_kind: p.rule_kind, ref_key: p.ref_key, last_raised_at: new Date().toISOString() },
              { onConflict: "rule_kind,ref_key" as any },
            );
          }
        }

        return json({ ok: true, proposed: proposed.length, inserted });
      },
    },
  },
});

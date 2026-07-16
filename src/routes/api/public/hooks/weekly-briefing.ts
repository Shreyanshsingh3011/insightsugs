import { truncateJsonForPrompt } from "@/lib/json-truncate";
import { createFileRoute } from "@tanstack/react-router";
import { isHookAuthorized } from "@/lib/hook-auth.server";
import { createClient } from "@supabase/supabase-js";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Section = { title: string; summary: string; bullets: string[] };

async function generateAiSections(rawData: unknown, opts: { scope: "user" | "org"; audience: string }): Promise<Section[]> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) return [{ title: "Summary", summary: "AI not configured.", bullets: [] }];
  const prompt = `You are writing a concise weekly briefing for ${opts.audience}. Cover the last 7 days.
Return STRICT JSON only, no prose, matching:
{"sections":[{"title": string, "summary": string, "bullets": string[]}]}
Include one section per non-empty area from: "Projects & activities", "Sheets", "Documents", "Alerts & concerns".
Keep it factual, terse (max 3 sentences summary, max 5 bullets per section). Data:
${truncateJsonForPrompt(rawData, 12000)}`;
  try {
    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "You write concise weekly operations briefings and return JSON only." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!resp.ok) return [{ title: "Summary", summary: `AI error ${resp.status}`, bullets: [] }];
    const j: any = await resp.json();
    const text = j?.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(text);
    const sections = Array.isArray(parsed?.sections) ? parsed.sections : [];
    return sections
      .filter((s: any) => s && typeof s.title === "string")
      .map((s: any) => ({
        title: String(s.title),
        summary: String(s.summary ?? ""),
        bullets: Array.isArray(s.bullets) ? s.bullets.map((b: any) => String(b)).slice(0, 6) : [],
      }));
  } catch (e: any) {
    return [{ title: "Summary", summary: `AI parse error: ${e?.message ?? "unknown"}`, bullets: [] }];
  }
}

function sectionsToMarkdown(sections: Section[], header: string): string {
  const parts: string[] = [`# ${header}`, ""];
  for (const s of sections) {
    parts.push(`## ${s.title}`);
    if (s.summary) parts.push(s.summary);
    if (s.bullets?.length) {
      for (const b of s.bullets) parts.push(`- ${b}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

export const Route = createFileRoute("/api/public/hooks/weekly-briefing")({
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
        const end = new Date(now);
        const start = new Date(now);
        start.setDate(start.getDate() - 7);
        const startISO = start.toISOString().slice(0, 10);
        const endISO = end.toISOString().slice(0, 10);
        const startTs = start.toISOString();

        // Common data (all projects/activities/alerts). We'll filter per-user in memory.
        const [{ data: projects }, { data: activities }, { data: alerts }, { data: concerns }, { data: documents }, { data: sheets }, { data: users }, { data: roles }] =
          await Promise.all([
            admin.from("projects").select("id, name"),
            admin.from("activities").select("id, title, project_id, status, due_date, completed_at, assignee_id, updated_at"),
            admin.from("alerts").select("id, flag_id, activity, severity, status, created_at").gte("created_at", startTs),
            admin.from("concerns").select("id, title, status, severity, created_at").gte("created_at", startTs),
            admin.from("documents").select("id, name, owner_id, visibility, created_at, updated_at").gte("updated_at", startTs),
            admin.from("sheet_registry").select("id, display_name, user_id, visibility, last_refreshed_at, row_count"),
            admin.from("profiles").select("id, full_name, email"),
            admin.from("user_roles").select("user_id, role"),
          ]);

        const usersById = new Map<string, { id: string; full_name: string; email: string }>();
        for (const u of users ?? []) usersById.set(u.id, u as any);
        const rolesByUser = new Map<string, string[]>();
        for (const r of roles ?? []) {
          const arr = rolesByUser.get(r.user_id) ?? [];
          arr.push(r.role);
          rolesByUser.set(r.user_id, arr);
        }
        const isAdmin = (uid: string) => (rolesByUser.get(uid) ?? []).some((r) => r === "admin" || r === "super_admin");
        const projectName = (id: string | null | undefined) => (id ? (projects ?? []).find((p) => p.id === id)?.name ?? "" : "");

        // Doc shares (for shared visibility)
        const { data: docShares } = await admin.from("document_shares").select("document_id, user_id");
        const { data: sheetShares } = await admin.from("sheet_registry_shares").select("sheet_registry_id, user_id");
        const docSharedTo = new Map<string, Set<string>>();
        for (const s of docShares ?? []) {
          const set = docSharedTo.get(s.document_id) ?? new Set();
          set.add(s.user_id);
          docSharedTo.set(s.document_id, set);
        }
        const sheetSharedTo = new Map<string, Set<string>>();
        for (const s of sheetShares ?? []) {
          const set = sheetSharedTo.get(s.sheet_registry_id) ?? new Set();
          set.add(s.user_id);
          sheetSharedTo.set(s.sheet_registry_id, set);
        }

        // Per-user briefing preferences
        const { data: prefRows } = await admin
          .from("briefing_preferences")
          .select("user_id, sections, overdue_priority");
        const prefsByUser = new Map<string, { sections: string[]; overdue_priority: string }>();
        for (const p of prefRows ?? []) prefsByUser.set(p.user_id, { sections: p.sections, overdue_priority: p.overdue_priority });
        const defaultPrefs = { sections: ["projects", "sheets", "documents", "alerts"], overdue_priority: "top" };

        const briefingUrl = `${new URL(request.url).origin}/briefings`;
        const generated: Array<{ user_id: string | null; scope: "user" | "org"; sections: Section[]; email?: string; name?: string }> = [];

        // Per-user briefing
        for (const u of users ?? []) {
          const uid = u.id;
          const admin_ = isAdmin(uid);
          const prefs = prefsByUser.get(uid) ?? defaultPrefs;
          const enabled = new Set(prefs.sections);
          const myActivities = (activities ?? []).filter((a) => a.assignee_id === uid);

          // Overdue sorting per preference
          const overdueList = myActivities.filter((a) => a.due_date && a.due_date < endISO && a.status !== "completed");
          const sortedOverdue = [...overdueList].sort((a, b) => {
            if (prefs.overdue_priority === "by_due_date") return (a.due_date ?? "").localeCompare(b.due_date ?? "");
            if (prefs.overdue_priority === "by_age") return (a.updated_at ?? "").localeCompare(b.updated_at ?? "");
            return 0; // "top" — keep insertion order, AI will surface first
          }).slice(0, 10).map((a) => ({ title: a.title, due: a.due_date, project: projectName(a.project_id) }));

          const completed = myActivities.filter((a) => a.completed_at && a.completed_at >= startTs).length;
          const upcoming = myActivities
            .filter((a) => a.due_date && a.due_date >= endISO && a.status !== "completed")
            .slice(0, 8)
            .map((a) => ({ title: a.title, due: a.due_date, project: projectName(a.project_id) }));

          const visibleDocs = (documents ?? []).filter((d) =>
            d.owner_id === uid || d.visibility === "public" || admin_ || (d.visibility === "shared" && docSharedTo.get(d.id)?.has(uid)),
          );
          const visibleSheets = (sheets ?? []).filter((s) =>
            s.user_id === uid || s.visibility === "public" || admin_ || (s.visibility === "shared" && sheetSharedTo.get(s.id)?.has(uid)),
          );
          const myAlerts = (alerts ?? []).slice(0, 15);
          const myConcerns = (concerns ?? []).slice(0, 15);

          const raw: any = {
            audience: u.full_name || u.email || "user",
            week: { start: startISO, end: endISO },
            preferences: { enabled_sections: prefs.sections, overdue_priority: prefs.overdue_priority },
          };
          if (enabled.has("projects")) {
            raw.activities = {
              assigned_total: myActivities.length,
              overdue_count: overdueList.length,
              overdue_prioritized: sortedOverdue,
              completed_last_7d: completed,
              upcoming,
            };
          }
          if (enabled.has("documents")) {
            raw.documents = { updated_last_7d: visibleDocs.length, samples: visibleDocs.slice(0, 5).map((d) => d.name) };
          }
          if (enabled.has("sheets")) {
            raw.sheets = { visible: visibleSheets.length, samples: visibleSheets.slice(0, 5).map((s) => s.display_name) };
          }
          if (enabled.has("alerts")) {
            raw.alerts_and_concerns = {
              alerts_last_7d: myAlerts.map((a) => ({ activity: a.activity, severity: a.severity })),
              concerns_last_7d: myConcerns.map((c) => ({ title: c.title, severity: c.severity, status: c.status })),
            };
          }

          const hasAnything = myActivities.length + visibleDocs.length + visibleSheets.length + myAlerts.length + myConcerns.length > 0;
          if (!hasAnything) continue;

          const sections = await generateAiSections(raw, { scope: "user", audience: u.full_name || u.email || "you" });
          const markdown = sectionsToMarkdown(sections, `Your weekly briefing · ${startISO} → ${endISO}`);
          await admin
            .from("weekly_briefings")
            .upsert(
              { user_id: uid, scope: "user", week_start: startISO, week_end: endISO, content_json: { sections }, content_markdown: markdown },
              { onConflict: "user_id,scope,week_start" as any },
            );
          generated.push({ user_id: uid, scope: "user", sections, email: u.email, name: u.full_name });
        }

        // Org briefing (admins only)
        const orgRaw = {
          week: { start: startISO, end: endISO },
          activities_total: (activities ?? []).length,
          overdue_total: (activities ?? []).filter((a) => a.due_date && a.due_date < endISO && a.status !== "completed").length,
          completed_last_7d: (activities ?? []).filter((a) => a.completed_at && a.completed_at >= startTs).length,
          alerts_open_last_7d: (alerts ?? []).length,
          concerns_open_last_7d: (concerns ?? []).length,
          documents_updated_last_7d: (documents ?? []).length,
          top_projects: (projects ?? []).slice(0, 10).map((p) => p.name),
        };
        const orgSections = await generateAiSections(orgRaw, { scope: "org", audience: "organization leadership" });
        const orgMarkdown = sectionsToMarkdown(orgSections, `Org weekly briefing · ${startISO} → ${endISO}`);
        await admin
          .from("weekly_briefings")
          .upsert(
            { user_id: null, scope: "org", week_start: startISO, week_end: endISO, content_json: { sections: orgSections }, content_markdown: orgMarkdown },
            { onConflict: "user_id,scope,week_start" as any },
          );

        // Enqueue emails
        const { enqueueAppEmail } = await import("@/lib/email/enqueue-app-email.server");
        let emailQueued = 0;
        for (const g of generated) {
          if (!g.email) continue;
          const r = await enqueueAppEmail({
            templateName: "weekly-briefing",
            recipientEmail: g.email,
            idempotencyKey: `briefing-user-${g.user_id}-${startISO}`,
            templateData: {
              recipientName: g.name,
              weekStart: startISO,
              weekEnd: endISO,
              scope: "user",
              sections: g.sections,
              briefingUrl,
            },
          });
          if (r.ok) emailQueued++;
        }
        // Org email to each admin
        for (const u of users ?? []) {
          if (!isAdmin(u.id) || !u.email) continue;
          const r = await enqueueAppEmail({
            templateName: "weekly-briefing",
            recipientEmail: u.email,
            idempotencyKey: `briefing-org-${u.id}-${startISO}`,
            templateData: {
              recipientName: u.full_name,
              weekStart: startISO,
              weekEnd: endISO,
              scope: "org",
              sections: orgSections,
              briefingUrl,
            },
          });
          if (r.ok) emailQueued++;
        }

        return json({ ok: true, users_briefed: generated.length, emails_queued: emailQueued, week: { start: startISO, end: endISO } });
      },
    },
  },
});

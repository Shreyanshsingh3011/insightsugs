// Server-only core for summarizeThread. Reused by:
//   - createServerFn `summarizeThread` (auth-scoped Supabase client, RLS applies)
//   - the /api/chat tool `summarizeThread` (supabaseAdmin, since the chat
//     route already scopes tools per actor via the routed agent)
//
// Keeping this shared means the "keyword vs expanded" match-mode toggle stays
// consistent everywhere the brief is generated.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ThreadBriefCoreInput = {
  kind: "concern" | "alert";
  id: string;
  matchMode?: "keyword" | "expanded";
};

export type ThreadBriefCore = {
  ok: true;
  kind: "concern" | "alert";
  id: string;
  title: string;
  status: string;
  severity: string | null;
  participants: Array<{ id: string; name: string; role: "raiser" | "responder" | "recipient" }>;
  message_count: number;
  linked_docs: Array<{ id: string; name: string; summary: string | null }>;
  brief: string;
  bullets: string[];
  recommended_decision: string;
  match_mode: "keyword" | "expanded";
};

async function aiSummarize(system: string, user: string): Promise<string> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) return "";
  try {
    const [{ generateText }, { createLovableAiGatewayProvider }] = await Promise.all([
      import("ai"),
      import("@/lib/ai-gateway.server"),
    ]);
    const gateway = createLovableAiGatewayProvider(key);
    const { text } = await generateText({
      model: gateway("google/gemini-3-flash-preview"),
      system,
      prompt: user,
    });
    return (text ?? "").trim();
  } catch (e) {
    return `(AI summary unavailable: ${(e as Error).message})`;
  }
}

export async function summarizeThreadCore(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  input: ThreadBriefCoreInput,
): Promise<ThreadBriefCore | { ok: false; error: string }> {
  const matchMode: "keyword" | "expanded" = input.matchMode ?? "keyword";

  let title = "";
  let status = "";
  let severity: string | null = null;
  let bodyText = "";
  let activityHint = "";
  const participants: ThreadBriefCore["participants"] = [];
  const messagesRaw: Array<{ author_id: string; body: string; created_at: string }> = [];

  if (input.kind === "concern") {
    const { data: c, error } = await supabase
      .from("concerns")
      .select("id, title, body, status, severity, activity, raised_by, acknowledged_by, resolved_by")
      .eq("id", input.id)
      .maybeSingle();
    if (error || !c) return { ok: false, error: error?.message ?? "Concern not found" };
    title = c.title;
    status = c.status;
    severity = c.severity;
    bodyText = c.body ?? "";
    activityHint = c.activity ?? "";
    const ids = [c.raised_by, c.acknowledged_by, c.resolved_by].filter(Boolean) as string[];
    if (ids.length) {
      const { data: profs } = await supabase.from("profiles").select("id, full_name").in("id", ids);
      for (const p of profs ?? []) {
        const role: "raiser" | "responder" = p.id === c.raised_by ? "raiser" : "responder";
        participants.push({ id: p.id, name: p.full_name ?? "Unknown", role });
      }
    }
    const { data: msgs } = await supabase
      .from("concern_messages")
      .select("author_id, body, created_at")
      .eq("concern_id", input.id)
      .order("created_at", { ascending: true })
      .limit(200);
    messagesRaw.push(...(msgs ?? []));
  } else {
    const { data: a, error } = await supabase
      .from("alerts")
      .select("id, activity, reason, root_cause, status, severity, sent_by, resolved_by")
      .eq("id", input.id)
      .maybeSingle();
    if (error || !a) return { ok: false, error: error?.message ?? "Alert not found" };
    title = `Alert: ${a.activity}`;
    status = a.status;
    severity = a.severity;
    bodyText = [a.reason, a.root_cause].filter(Boolean).join("\n\n");
    activityHint = a.activity ?? "";
    const ids = [a.sent_by, a.resolved_by].filter(Boolean) as string[];
    if (ids.length) {
      const { data: profs } = await supabase.from("profiles").select("id, full_name").in("id", ids);
      for (const p of profs ?? []) {
        participants.push({
          id: p.id,
          name: p.full_name ?? "Unknown",
          role: p.id === a.sent_by ? "raiser" : "responder",
        });
      }
    }
    const { data: recips } = await supabase
      .from("alert_recipients")
      .select("user_id")
      .eq("alert_id", input.id);
    const recipIds = (recips ?? []).map((r) => r.user_id).filter(Boolean) as string[];
    if (recipIds.length) {
      const { data: rProfs } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", recipIds);
      for (const p of rProfs ?? []) {
        participants.push({
          id: p.id,
          name: p.full_name ?? "Recipient",
          role: "recipient",
        });
      }
    }
    const { data: msgs } = await supabase
      .from("alert_messages")
      .select("author_id, body, created_at")
      .eq("alert_id", input.id)
      .order("created_at", { ascending: true })
      .limit(200);
    messagesRaw.push(...(msgs ?? []));
  }

  const authorIds = Array.from(new Set(messagesRaw.map((m) => m.author_id)));
  const nameById = new Map<string, string>();
  if (authorIds.length) {
    const { data: profs } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", authorIds);
    for (const p of profs ?? []) nameById.set(p.id, p.full_name ?? "Unknown");
  }
  const messages = messagesRaw.map((m) => ({
    name: nameById.get(m.author_id) ?? "Unknown",
    body: m.body,
    created_at: m.created_at,
  }));

  let linked: ThreadBriefCore["linked_docs"] = [];
  const needle = (activityHint || title).trim().slice(0, 60);
  const orParts: string[] = [];
  if (needle) {
    orParts.push(`name.ilike.%${needle}%`, `summary.ilike.%${needle}%`);
  }
  if (matchMode === "expanded") {
    const extraTerms = [...participants.map((p) => p.name).filter(Boolean), severity ?? ""]
      .map((t) => t.trim())
      .filter((t) => t.length >= 3)
      .slice(0, 4);
    for (const t of extraTerms) {
      const safe = t.replace(/[,()]/g, " ").slice(0, 40);
      orParts.push(`name.ilike.%${safe}%`, `summary.ilike.%${safe}%`);
    }
  }
  if (orParts.length) {
    const { data: docs } = await supabase
      .from("documents")
      .select("id, name, summary")
      .or(orParts.join(","))
      .limit(matchMode === "expanded" ? 10 : 5);
    linked = (docs ?? []).map((d) => ({ id: d.id, name: d.name, summary: d.summary }));
  }

  const transcript = messages
    .map((m) => `- [${m.created_at.slice(0, 16).replace("T", " ")}] ${m.name}: ${m.body}`)
    .join("\n");
  const docsBlock = linked.length
    ? linked.map((d) => `- ${d.name}${d.summary ? ` — ${d.summary.slice(0, 240)}` : ""}`).join("\n")
    : "(no linked documents)";
  const userMsg = [
    `${input.kind.toUpperCase()}: ${title}`,
    `Status: ${status}${severity ? ` · Severity: ${severity}` : ""}`,
    activityHint ? `Related activity: ${activityHint}` : "",
    "",
    "Original description:",
    bodyText || "(none)",
    "",
    "Thread transcript:",
    transcript || "(no replies yet)",
    "",
    "Linked documents:",
    docsBlock,
  ]
    .filter(Boolean)
    .join("\n");

  const brief = await aiSummarize(
    "You are a project delivery analyst. Produce a decision-ready brief for a manager who has 60 seconds. " +
      "Structure the response as three plain-text sections separated by blank lines: " +
      "1) BRIEF: 2-3 sentence summary of the situation and where it stands. " +
      "2) KEY POINTS: 3-6 short bullets starting with '- '. " +
      "3) RECOMMENDED DECISION: one sentence with a clear action. " +
      "Cite specific names, dates, and numbers. Do not invent facts.",
    userMsg,
  );

  const sections = brief.split(/\n\s*\n/);
  const briefPart =
    sections.find((s) => /BRIEF/i.test(s))?.replace(/^[^:]*:\s*/i, "").trim() ??
    sections[0]?.trim() ??
    "";
  const bulletsPart = sections.find((s) => /KEY POINTS|BULLETS/i.test(s)) ?? "";
  const bullets = bulletsPart
    .split("\n")
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter((l) => l && !/KEY POINTS|BULLETS/i.test(l));
  const decision =
    sections
      .find((s) => /RECOMMEND|DECISION/i.test(s))
      ?.replace(/^[^:]*:\s*/i, "")
      .trim() ?? "";

  return {
    ok: true,
    kind: input.kind,
    id: input.id,
    title,
    status,
    severity,
    participants,
    message_count: messages.length,
    linked_docs: linked,
    brief: briefPart,
    bullets,
    recommended_decision: decision,
    match_mode: matchMode,
  };
}

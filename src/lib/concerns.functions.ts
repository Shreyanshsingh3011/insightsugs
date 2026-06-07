import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const SEV = z.enum(["Low", "Medium", "High", "Critical"]);

export const raiseConcern = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: {
    target_dept: string;
    title: string;
    body?: string;
    severity: "Low" | "Medium" | "High" | "Critical";
    activity?: string | null;
    registry_id?: string | null;
    row_index?: number | null;
    owner_email?: string | null;
  }) =>
    z
      .object({
        target_dept: z.string().trim().min(1).max(120),
        title: z.string().trim().min(1).max(200),
        body: z.string().max(4000).optional().default(""),
        severity: SEV,
        activity: z.string().max(500).nullable().optional(),
        registry_id: z.string().uuid().nullable().optional(),
        row_index: z.number().int().nullable().optional(),
        owner_email: z.string().email().max(320).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: profile } = await supabase
      .from("profiles")
      .select("department, full_name, email")
      .eq("id", userId)
      .maybeSingle();

    const { data: concern, error } = await supabase
      .from("concerns" as any)
      .insert({
        raised_by: userId,
        raised_by_dept: profile?.department ?? null,
        target_dept: data.target_dept,
        registry_id: data.registry_id ?? null,
        row_index: data.row_index ?? null,
        activity: data.activity ?? null,
        title: data.title,
        body: data.body ?? "",
        severity: data.severity,
      })
      .select("id")
      .single();
    if (error || !concern) throw new Error(error?.message ?? "Failed to raise concern");

    // Resolve target-department recipients via admin client
    const { data: deptMembers } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name, email")
      .eq("department", data.target_dept);

    const recipients = new Map<string, { user_id: string | null; email: string; name: string | null }>();
    for (const m of deptMembers ?? []) {
      if (!m.email) continue;
      recipients.set(m.email.toLowerCase(), { user_id: m.id, email: m.email, name: m.full_name });
    }
    if (data.owner_email) {
      const key = data.owner_email.toLowerCase();
      if (!recipients.has(key)) {
        recipients.set(key, { user_id: null, email: data.owner_email, name: null });
      }
    }

    // In-app notifications
    const notifRows = Array.from(recipients.values())
      .filter((r) => r.user_id)
      .map((r) => ({
        user_id: r.user_id!,
        kind: "concern",
        title: `Concern raised: ${data.title}`.slice(0, 200),
        body: `${data.severity} · from ${profile?.full_name || "a teammate"}${data.activity ? ` · ${data.activity}` : ""}`.slice(0, 500),
      }));
    if (notifRows.length) {
      await supabaseAdmin.from("notifications").insert(notifRows);
    }

    // Best-effort email enqueue via existing email infra (auth_emails RPC)
    try {
      for (const r of recipients.values()) {
        await supabaseAdmin.rpc("enqueue_email" as any, {
          queue_name: "transactional_emails",
          payload: {
            label: "concern",
            to: r.email,
            subject: `[${data.severity}] Concern: ${data.title}`.slice(0, 200),
            text: `${profile?.full_name || "A teammate"} raised a concern targeted at ${data.target_dept}.\n\nTitle: ${data.title}\nSeverity: ${data.severity}\nActivity: ${data.activity ?? "—"}\n\n${data.body ?? ""}\n\nOpen the Concerns inbox to respond.`,
            concern_id: concern.id,
          },
        });
      }
    } catch {
      // email infra may not be wired; notifications still went through
    }

    return { id: concern.id, recipientCount: recipients.size };
  });

export const listConcerns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as any;
    const { data, error } = await supabase
      .from("concerns" as any)
      .select(
        "id, raised_by, raised_by_dept, target_dept, activity, title, body, severity, status, created_at, acknowledged_at, resolved_at",
      )
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return { concerns: (data ?? []) as any[], me: userId };
  });

export const getConcern = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => ({ id: z.string().uuid().parse(d.id) }))
  .handler(async ({ data, context }) => {
    const { supabase } = context as any;
    const { data: concern, error } = await supabase
      .from("concerns" as any)
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!concern) throw new Error("Concern not found or access denied.");

    const { data: messages } = await supabase
      .from("concern_messages" as any)
      .select("id, body, author_id, created_at")
      .eq("concern_id", data.id)
      .order("created_at");

    const authorIds = Array.from(new Set((messages ?? []).map((m: any) => m.author_id)));
    let authorMap: Record<string, { full_name: string | null; email: string | null }> = {};
    if (authorIds.length) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: profs } = await supabaseAdmin
        .from("profiles")
        .select("id, full_name, email")
        .in("id", authorIds);
      (profs ?? []).forEach((p: any) => {
        authorMap[p.id] = { full_name: p.full_name, email: p.email };
      });
    }

    return {
      concern,
      messages: (messages ?? []).map((m: any) => ({ ...m, author: authorMap[m.author_id] ?? null })),
    };
  });

export const replyToConcern = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; body: string }) => ({
    id: z.string().uuid().parse(d.id),
    body: z.string().trim().min(1).max(4000).parse(d.body),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    const { error } = await supabase
      .from("concern_messages" as any)
      .insert({ concern_id: data.id, author_id: userId, body: data.body });
    if (error) throw new Error(error.message);

    // Notify the raiser + target dept members in-app
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: c } = await supabaseAdmin
      .from("concerns" as any)
      .select("raised_by, target_dept, title")
      .eq("id", data.id)
      .maybeSingle();
    if (c) {
      const { data: deptMembers } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .eq("department", (c as any).target_dept);
      const ids = new Set<string>([
        ...((deptMembers ?? []).map((d: any) => d.id) as string[]),
        (c as any).raised_by,
      ]);
      ids.delete(userId);
      if (ids.size) {
        await supabaseAdmin.from("notifications").insert(
          Array.from(ids).map((uid) => ({
            user_id: uid,
            kind: "concern_reply",
            title: `New reply on concern: ${(c as any).title}`.slice(0, 200),
            body: data.body.slice(0, 500),
          })),
        );
      }
    }
    return { ok: true };
  });

async function setStatus(supabase: any, userId: string, id: string, status: "acknowledged" | "resolved") {
  const patch: any = { status };
  if (status === "acknowledged") {
    patch.acknowledged_by = userId;
    patch.acknowledged_at = new Date().toISOString();
  } else {
    patch.resolved_by = userId;
    patch.resolved_at = new Date().toISOString();
  }
  const { error } = await supabase.from("concerns" as any).update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}

export const acknowledgeConcern = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => ({ id: z.string().uuid().parse(d.id) }))
  .handler(async ({ data, context }) => {
    await setStatus((context as any).supabase, (context as any).userId, data.id, "acknowledged");
    return { ok: true };
  });

export const resolveConcern = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => ({ id: z.string().uuid().parse(d.id) }))
  .handler(async ({ data, context }) => {
    await setStatus((context as any).supabase, (context as any).userId, data.id, "resolved");
    return { ok: true };
  });

export const listDepartments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin.from("profiles").select("department");
    const set = new Set<string>();
    for (const r of data ?? []) {
      const d = (r as any).department?.trim();
      if (d) set.add(d);
    }
    return { departments: Array.from(set).sort() };
  });

export const unreadConcernCount = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context as any;
    const { count } = await supabase
      .from("concerns" as any)
      .select("id", { count: "exact", head: true })
      .eq("status", "open");
    return { count: count ?? 0 };
  });

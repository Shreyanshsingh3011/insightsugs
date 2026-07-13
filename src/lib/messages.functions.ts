import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type DirectMessage = {
  id: string;
  sender_id: string;
  recipient_id: string;
  subject: string | null;
  body: string;
  context_kind: string | null;
  context_ref: string | null;
  created_at: string;
  read_at: string | null;
  sender?: { full_name: string; email: string } | null;
  recipient?: { full_name: string; email: string } | null;
};

export type DirectoryUser = { id: string; full_name: string; email: string; department: string | null };

async function attachProfiles(
  supabase: any,
  rows: DirectMessage[],
): Promise<DirectMessage[]> {
  const ids = Array.from(
    new Set(rows.flatMap((r) => [r.sender_id, r.recipient_id])),
  );
  if (ids.length === 0) return rows;
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, email")
    .in("id", ids);
  const map = new Map<string, { full_name: string; email: string }>(
    (data ?? []).map((p: any) => [p.id, { full_name: p.full_name ?? "", email: p.email ?? "" }]),
  );
  return rows.map((r) => ({
    ...r,
    sender: map.get(r.sender_id) ?? null,
    recipient: map.get(r.recipient_id) ?? null,
  }));
}

async function withTimeout<T>(p: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return await Promise.race([
    Promise.resolve(p),
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timeout`)), ms)),
  ]);
}

export const listInbox = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    try {
      const { data, error } = await withTimeout(
        supabase
          .from("direct_messages")
          .select("*")
          .eq("recipient_id", userId)
          .order("created_at", { ascending: false })
          .limit(100),
        8000,
        "listInbox",
      );
      if (error) throw new Error(error.message);
      const rows = await attachProfiles(supabase, (data ?? []) as DirectMessage[]);
      return { messages: rows, degraded: false as const };
    } catch (e) {
      console.error("[listInbox] degraded:", (e as Error).message);
      return { messages: [] as DirectMessage[], degraded: true as const };
    }
  });

export const listSent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    try {
      const { data, error } = await withTimeout(
        supabase
          .from("direct_messages")
          .select("*")
          .eq("sender_id", userId)
          .order("created_at", { ascending: false })
          .limit(100),
        8000,
        "listSent",
      );
      if (error) throw new Error(error.message);
      const rows = await attachProfiles(supabase, (data ?? []) as DirectMessage[]);
      return { messages: rows, degraded: false as const };
    } catch (e) {
      console.error("[listSent] degraded:", (e as Error).message);
      return { messages: [] as DirectMessage[], degraded: true as const };
    }
  });

export const listDirectory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { data, error } = await supabase
      .from("profiles")
      .select("id, full_name, email, department")
      .neq("id", userId)
      .order("full_name")
      .limit(500);
    if (error) throw new Error(error.message);
    return { users: (data ?? []) as DirectoryUser[] };
  });

export const sendDirectMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: {
    recipient_id: string;
    subject?: string;
    body: string;
    context_kind?: string;
    context_ref?: string;
  }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    if (!data.recipient_id) throw new Error("Recipient required");
    if (!data.body?.trim()) throw new Error("Message body required");
    if (data.recipient_id === userId) throw new Error("Cannot message yourself");

    const { data: inserted, error } = await supabase
      .from("direct_messages")
      .insert({
        sender_id: userId,
        recipient_id: data.recipient_id,
        subject: data.subject?.trim() || null,
        body: data.body.trim(),
        context_kind: data.context_kind ?? null,
        context_ref: data.context_ref ?? null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    // Best-effort notification (RLS on notifications allows service_role; if not, ignore).
    try {
      const { data: sender } = await supabase
        .from("profiles").select("full_name, email").eq("id", userId).maybeSingle();
      const from = sender?.full_name || sender?.email || "A colleague";
      await supabase.from("notifications").insert({
        user_id: data.recipient_id,
        kind: "message",
        title: `New message from ${from}`,
        body: data.subject?.trim() || data.body.slice(0, 140),
      });
    } catch { /* non-fatal */ }

    return { id: inserted?.id as string };
  });

export const markMessageRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { error } = await supabase
      .from("direct_messages")
      .update({ read_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("recipient_id", userId)
      .is("read_at", null);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const markAllInboxRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { error } = await supabase
      .from("direct_messages")
      .update({ read_at: new Date().toISOString() })
      .eq("recipient_id", userId)
      .is("read_at", null);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

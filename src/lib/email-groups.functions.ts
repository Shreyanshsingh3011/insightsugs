import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const AppliesTo = z.object({
  severities: z.array(z.string().max(50)).max(20).optional(),
  stages: z.array(z.string().max(200)).max(50).optional(),
  activities: z.array(z.string().max(500)).max(100).optional(),
  alert_types: z.array(z.string().max(50)).max(20).optional(),
}).strict();

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  if (error) throw new Error(error.message);
  const roles = (data ?? []).map((r: any) => r.role);
  if (!roles.includes("admin") && !roles.includes("super_admin")) {
    throw new Error("Only admins can manage email groups.");
  }
}

export const listEmailGroups = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);
    const { data: groups, error } = await supabase
      .from("email_groups")
      .select("id, name, description, applies_to, created_at, updated_at")
      .order("name", { ascending: true });
    if (error) throw new Error(error.message);
    const ids = (groups ?? []).map((g: any) => g.id);
    let members: any[] = [];
    if (ids.length) {
      const { data: m, error: mErr } = await supabase
        .from("email_group_members")
        .select("id, group_id, email, name")
        .in("group_id", ids);
      if (mErr) throw new Error(mErr.message);
      members = m ?? [];
    }
    return (groups ?? []).map((g: any) => ({
      ...g,
      members: members.filter((m) => m.group_id === g.id),
    }));
  });

export const upsertEmailGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id?: string; name: string; description?: string | null; applies_to?: unknown; members: Array<{ email: string; name?: string | null }> }) => ({
    id: d.id ? z.string().uuid().parse(d.id) : undefined,
    name: z.string().trim().min(1).max(120).parse(d.name),
    description: d.description ? z.string().max(500).parse(d.description) : null,
    applies_to: AppliesTo.parse(d.applies_to ?? {}),
    members: z.array(z.object({
      email: z.string().email().max(255).transform((s) => s.trim().toLowerCase()),
      name: z.string().max(255).optional().nullable(),
    })).max(500).parse(d.members ?? []),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);

    let groupId = data.id;
    if (groupId) {
      const { error } = await supabase
        .from("email_groups")
        .update({ name: data.name, description: data.description, applies_to: data.applies_to })
        .eq("id", groupId);
      if (error) throw new Error(error.message);
    } else {
      const { data: ins, error } = await supabase
        .from("email_groups")
        .insert({ owner_id: userId, name: data.name, description: data.description, applies_to: data.applies_to })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      groupId = ins.id;
    }

    // Replace members
    const { error: delErr } = await supabase.from("email_group_members").delete().eq("group_id", groupId);
    if (delErr) throw new Error(delErr.message);
    if (data.members.length) {
      // dedupe
      const seen = new Set<string>();
      const rows = data.members.filter((m) => {
        if (seen.has(m.email)) return false;
        seen.add(m.email);
        return true;
      }).map((m) => ({ group_id: groupId, email: m.email, name: m.name ?? null }));
      const { error: insErr } = await supabase.from("email_group_members").insert(rows);
      if (insErr) throw new Error(insErr.message);
    }
    return { id: groupId };
  });

export const deleteEmailGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => ({ id: z.string().uuid().parse(d.id) }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);
    const { error } = await supabase.from("email_groups").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

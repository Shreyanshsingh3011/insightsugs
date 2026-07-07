/**
 * Role-scoped RLS regression test.
 *
 * Runs against the LIVE database. Creates 3 throwaway users
 * (super_admin/admin/user), seeds fixture data, queries each table via a
 * real per-user JWT (so RLS is actually enforced), asserts counts, and
 * cleans up.
 *
 *   Run:  bun run scripts/tests/rls-role-regression.ts
 *
 * Requires env vars (already in sandbox):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PUBLISHABLE_KEY
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY!;
if (!URL || !SERVICE || !PUB) throw new Error("Missing SUPABASE_URL / SERVICE_ROLE / PUBLISHABLE_KEY env");

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

type Role = "super_admin" | "admin" | "user";
const TAG = `rls-test-${Date.now()}`;

async function mkUser(role: Role): Promise<{ id: string; email: string; password: string }> {
  const email = `${TAG}-${role}@test.local`;
  const password = crypto.randomUUID();
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: role },
  });
  if (error || !data.user) throw new Error(`createUser(${role}): ${error?.message}`);
  const id = data.user.id;
  // handle_new_user trigger creates profile + a pending signup_request. Grant real role now.
  await admin.from("user_roles").delete().eq("user_id", id);
  const { error: rErr } = await admin.from("user_roles").insert({ user_id: id, role });
  if (rErr) throw new Error(`assign role ${role}: ${rErr.message}`);
  return { id, email, password };
}

async function signIn(email: string, password: string): Promise<SupabaseClient> {
  const anon = createClient(URL, PUB, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`signIn ${email}: ${error?.message}`);
  return createClient(URL, PUB, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });
}

let failures = 0;
function check(name: string, expected: number, actual: number) {
  const ok = expected === actual;
  console.log(`${ok ? "✅" : "❌"} ${name}: expected=${expected} actual=${actual}`);
  if (!ok) failures += 1;
}

async function main() {
  console.log("Seeding 3 throwaway users…");
  const su = await mkUser("super_admin");
  const ad = await mkUser("admin");
  const us = await mkUser("user");

  // Seed fixtures as service role.
  const projA = crypto.randomUUID();
  const projB = crypto.randomUUID();
  await admin.from("projects").insert([
    { id: projA, name: `${TAG} A`, owner_id: ad.id },
    { id: projB, name: `${TAG} B`, owner_id: su.id },
  ]);
  const { data: paIns, error: paErr } = await admin.from("pending_actions").insert([
    { kind: "create_alert", summary: `${TAG} A`, payload: { project_id: projA }, status: "pending" },
    { kind: "create_alert", summary: `${TAG} B`, payload: { project_id: projB }, status: "pending" },
  ]).select("id, summary");
  if (paErr) throw paErr;
  const paA = paIns!.find((r: any) => r.summary.endsWith(" A"))!.id;
  const paB = paIns!.find((r: any) => r.summary.endsWith(" B"))!.id;

  await admin.from("alerts").insert([
    { flag_id: `${TAG}-A`, activity: "a", sent_by: ad.id },
    { flag_id: `${TAG}-B`, activity: "b", sent_by: su.id },
  ]);
  await admin.from("audit_log").insert([
    { actor_id: su.id, event_type: `${TAG}-a`, project_id: projA },
    { actor_id: su.id, event_type: `${TAG}-b`, project_id: projB },
    { actor_id: su.id, event_type: `${TAG}-g`, project_id: null },
  ]);

  try {
    const cliSu = await signIn(su.email, su.password);
    const cliAd = await signIn(ad.email, ad.password);
    const cliUs = await signIn(us.email, us.password);

    // ---- SUPER ADMIN: sees everything --------------------------------
    let r;
    r = await cliSu.from("pending_actions").select("id").in("id", [paA, paB]);
    check("super/pending_actions (both)", 2, r.data?.length ?? -1);
    r = await cliSu.from("alerts").select("id").in("flag_id", [`${TAG}-A`, `${TAG}-B`]);
    check("super/alerts (both)", 2, r.data?.length ?? -1);
    r = await cliSu.from("audit_log").select("id").ilike("event_type", `${TAG}-%`);
    check("super/audit (all 3)", 3, r.data?.length ?? -1);

    // ---- ADMIN: scoped to project A ----------------------------------
    r = await cliAd.from("pending_actions").select("id, summary").in("id", [paA, paB]);
    check("admin/pending_actions (only A)", 1, r.data?.length ?? -1);
    if (r.data?.[0]?.id !== paA) { console.log("❌ admin saw wrong proposal:", r.data); failures++; }

    r = await cliAd.from("alerts").select("id").in("flag_id", [`${TAG}-A`, `${TAG}-B`]);
    check("admin/alerts (only sent)", 1, r.data?.length ?? -1);

    r = await cliAd.from("audit_log").select("id, event_type").ilike("event_type", `${TAG}-%`);
    check("admin/audit (own-project + null)", 2, r.data?.length ?? -1);
    const seen = new Set((r.data ?? []).map((x: any) => x.event_type));
    if (seen.has(`${TAG}-b`)) { console.log("❌ admin leaked foreign-project audit"); failures++; }

    // ---- USER: no project link, sees nothing scoped ------------------
    r = await cliUs.from("pending_actions").select("id").in("id", [paA, paB]);
    check("user/pending_actions (none)", 0, r.data?.length ?? -1);
    r = await cliUs.from("alerts").select("id").in("flag_id", [`${TAG}-A`, `${TAG}-B`]);
    check("user/alerts (none)", 0, r.data?.length ?? -1);
    r = await cliUs.from("audit_log").select("id").ilike("event_type", `${TAG}-%`);
    check("user/audit (none)", 0, r.data?.length ?? -1);
  } finally {
    console.log("Cleaning up…");
    await admin.from("audit_log").delete().ilike("event_type", `${TAG}-%`);
    await admin.from("alerts").delete().in("flag_id", [`${TAG}-A`, `${TAG}-B`]);
    await admin.from("pending_actions").delete().in("id", [paA, paB]);
    await admin.from("projects").delete().in("id", [projA, projB]);
    for (const u of [su, ad, us]) {
      await admin.auth.admin.deleteUser(u.id);
    }
  }

  console.log(failures === 0 ? "\n✅ All role-scoped RLS assertions passed." : `\n❌ ${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

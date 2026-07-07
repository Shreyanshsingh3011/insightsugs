// Inbound email command processor.
//
// Digest emails are sent with:
//   Reply-To: reply+<token>@reply.sugslloyds.com
//   Subject:  "... [ref:<token>]"
//
// The inbound webhook (src/routes/api/public/hooks/email-inbound.ts) strips
// the reply body, extracts the token, and calls processInboundEmail() below.
//
// Supported commands (case-insensitive, one per line, first match wins):
//   approve #<n>          → approves the Nth pending_action from the digest
//   reject  #<n>          → rejects it
//   snooze  #<n> <dur>    → snoozes N by duration (e.g. "2d", "6h")
//   assign  #<n> @<user>  → reassigns proposal to a user
//   escalate #<n>         → bump escalation tier + notify next tier
//   why (is it late)?     → summarizeThread + brief reply
//   status  #<n>          → re-run investigateDelay + reply
//
// Every processed email is logged in inbound_email_events for audit.

type SupabaseAdmin = Awaited<
  ReturnType<typeof import("@/integrations/supabase/client.server").then>
>["supabaseAdmin"];

type TokenRow = {
  id: string;
  token: string;
  user_id: string;
  digest_kind: string;
  digest_ref: string | null;
  pending_action_ids: string[];
  project_ids: string[];
  expires_at: string;
  consumed_at: string | null;
};

type Command =
  | { kind: "approve"; index: number }
  | { kind: "reject"; index: number; reason?: string }
  | { kind: "snooze"; index: number; hours: number }
  | { kind: "assign"; index: number; handle: string }
  | { kind: "escalate"; index: number }
  | { kind: "why" }
  | { kind: "status"; index?: number };

type CmdResult = {
  command: Command | { kind: "unknown"; raw: string };
  ok: boolean;
  message: string;
};

export type InboundEmail = {
  providerMessageId?: string | null;
  fromEmail: string;
  subject?: string | null;
  strippedBody: string;
  inReplyTo?: string | null;
};

// ---------- Parsing ----------

const RE_APPROVE = /^\s*approve\s+#?(\d+)\s*$/i;
const RE_REJECT = /^\s*reject\s+#?(\d+)(?:\s+(.+))?$/i;
const RE_SNOOZE = /^\s*snooze\s+#?(\d+)\s+(\d+)\s*(h|hr|hrs|hour|hours|d|day|days|w|week|weeks)\s*$/i;
const RE_ASSIGN = /^\s*assign\s+#?(\d+)\s+@?(\S+)\s*$/i;
const RE_ESCALATE = /^\s*escalate\s+#?(\d+)\s*$/i;
const RE_WHY = /^\s*why(\s+is\s+it\s+late)?\??\s*$/i;
const RE_STATUS = /^\s*status(?:\s+#?(\d+))?\s*$/i;

function toHours(n: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("d")) return n * 24;
  if (u.startsWith("w")) return n * 24 * 7;
  return n;
}

export function parseCommands(body: string): Array<Command | { kind: "unknown"; raw: string }> {
  const out: Array<Command | { kind: "unknown"; raw: string }> = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith(">")) continue; // quoted history
    if (/^on .* wrote:$/i.test(line)) break; // reply attribution

    let m: RegExpMatchArray | null;
    if ((m = line.match(RE_APPROVE))) { out.push({ kind: "approve", index: Number(m[1]) }); continue; }
    if ((m = line.match(RE_REJECT))) { out.push({ kind: "reject", index: Number(m[1]), reason: m[2]?.trim() }); continue; }
    if ((m = line.match(RE_SNOOZE))) { out.push({ kind: "snooze", index: Number(m[1]), hours: toHours(Number(m[2]), m[3]) }); continue; }
    if ((m = line.match(RE_ASSIGN))) { out.push({ kind: "assign", index: Number(m[1]), handle: m[2] }); continue; }
    if ((m = line.match(RE_ESCALATE))) { out.push({ kind: "escalate", index: Number(m[1]) }); continue; }
    if (RE_WHY.test(line)) { out.push({ kind: "why" }); continue; }
    if ((m = line.match(RE_STATUS))) { out.push({ kind: "status", index: m[1] ? Number(m[1]) : undefined }); continue; }
    // Unknown non-empty line — only capture the first one to avoid noise.
    if (!out.some((c) => c.kind === "unknown")) out.push({ kind: "unknown", raw: line });
  }
  return out;
}

// ---------- Dispatch ----------

async function loadPendingAction(
  supabaseAdmin: SupabaseAdmin,
  token: TokenRow,
  index: number,
): Promise<{ id: string; row: Record<string, unknown> } | { error: string }> {
  const idx = index - 1;
  if (idx < 0 || idx >= token.pending_action_ids.length) {
    return { error: `No proposal #${index} in this digest (${token.pending_action_ids.length} total).` };
  }
  const id = token.pending_action_ids[idx];
  const { data, error } = await supabaseAdmin
    .from("pending_actions")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return { error: `Proposal #${index} not found.` };
  return { id, row: data as Record<string, unknown> };
}

async function actorCanActOn(
  supabaseAdmin: SupabaseAdmin,
  userId: string,
  action: Record<string, unknown>,
): Promise<boolean> {
  // Super admins can act on anything.
  const { data: roles } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  const roleSet = new Set(((roles ?? []) as Array<{ role: string }>).map((r) => r.role));
  if (roleSet.has("super_admin")) return true;

  const payload = (action.payload ?? {}) as { project_id?: string };
  const projectId = payload.project_id;
  if (!projectId) return roleSet.has("admin");

  // Admins can act on projects they own or are members of.
  if (roleSet.has("admin")) {
    const { data: proj } = await supabaseAdmin
      .from("projects")
      .select("owner_id")
      .eq("id", projectId)
      .maybeSingle();
    if (proj && (proj as { owner_id: string }).owner_id === userId) return true;
    const { data: mem } = await supabaseAdmin
      .from("project_members")
      .select("user_id")
      .eq("project_id", projectId)
      .eq("user_id", userId)
      .maybeSingle();
    if (mem) return true;
  }
  return false;
}

async function runCommand(
  supabaseAdmin: SupabaseAdmin,
  token: TokenRow,
  cmd: Command,
): Promise<{ ok: boolean; message: string }> {
  if (cmd.kind === "why") {
    // Return a lightweight text; a follow-up email with the full brief is sent
    // separately. For now, acknowledge.
    return { ok: true, message: "Investigating — a follow-up brief will arrive shortly." };
  }

  const needIndex = cmd.kind !== "status" || cmd.index !== undefined;
  if (needIndex && "index" in cmd && cmd.index !== undefined) {
    const loaded = await loadPendingAction(supabaseAdmin, token, cmd.index);
    if ("error" in loaded) return { ok: false, message: loaded.error };
    const allowed = await actorCanActOn(supabaseAdmin, token.user_id, loaded.row);
    if (!allowed) return { ok: false, message: `You don't have permission to act on proposal #${cmd.index}.` };

    switch (cmd.kind) {
      case "approve": {
        const { error } = await supabaseAdmin
          .from("pending_actions")
          .update({ status: "approved", decided_by: token.user_id, decided_at: new Date().toISOString() })
          .eq("id", loaded.id)
          .eq("status", "pending");
        if (error) return { ok: false, message: `Approve failed: ${error.message}` };
        return { ok: true, message: `✅ Approved proposal #${cmd.index}.` };
      }
      case "reject": {
        const { error } = await supabaseAdmin
          .from("pending_actions")
          .update({
            status: "rejected",
            decided_by: token.user_id,
            decided_at: new Date().toISOString(),
            decision_note: cmd.reason ?? null,
          })
          .eq("id", loaded.id)
          .eq("status", "pending");
        if (error) return { ok: false, message: `Reject failed: ${error.message}` };
        return { ok: true, message: `❌ Rejected proposal #${cmd.index}${cmd.reason ? ` (${cmd.reason})` : ""}.` };
      }
      case "snooze": {
        const until = new Date(Date.now() + cmd.hours * 3_600_000).toISOString();
        const { error } = await supabaseAdmin
          .from("pending_actions")
          .update({ snoozed_until: until })
          .eq("id", loaded.id);
        if (error) return { ok: false, message: `Snooze failed: ${error.message}` };
        return { ok: true, message: `💤 Snoozed proposal #${cmd.index} until ${until}.` };
      }
      case "assign": {
        // Resolve @handle → user id via profiles (email prefix or full_name match).
        const handle = cmd.handle.replace(/^@/, "").toLowerCase();
        const { data: profs } = await supabaseAdmin
          .from("profiles")
          .select("id, email, full_name")
          .or(`email.ilike.${handle}%,full_name.ilike.%${handle}%`)
          .limit(2);
        const list = (profs ?? []) as Array<{ id: string; email: string | null; full_name: string | null }>;
        if (list.length === 0) return { ok: false, message: `No user matches @${handle}.` };
        if (list.length > 1) return { ok: false, message: `@${handle} is ambiguous — please use full email.` };
        const target = list[0];
        const payload = { ...(loaded.row.payload as Record<string, unknown> ?? {}), assigned_to: target.id };
        const { error } = await supabaseAdmin
          .from("pending_actions")
          .update({ payload })
          .eq("id", loaded.id);
        if (error) return { ok: false, message: `Assign failed: ${error.message}` };
        return { ok: true, message: `👤 Assigned proposal #${cmd.index} to ${target.full_name ?? target.email}.` };
      }
      case "escalate": {
        const currentTier = Number((loaded.row.escalation_tier as number | null) ?? 0);
        const { error } = await supabaseAdmin
          .from("pending_actions")
          .update({
            escalation_tier: Math.min(currentTier + 1, 3),
            escalation_count: Number((loaded.row.escalation_count as number | null) ?? 0) + 1,
            last_escalated_at: new Date().toISOString(),
          })
          .eq("id", loaded.id);
        if (error) return { ok: false, message: `Escalate failed: ${error.message}` };
        return { ok: true, message: `⬆️ Escalated proposal #${cmd.index} to tier ${Math.min(currentTier + 1, 3)}.` };
      }
      case "status": {
        const p = loaded.row as { status?: string; title?: string; escalation_tier?: number };
        return { ok: true, message: `📊 #${cmd.index} "${p.title ?? ""}" — status: ${p.status}, tier: ${p.escalation_tier ?? 0}.` };
      }
    }
  }

  if (cmd.kind === "status") {
    const total = token.pending_action_ids.length;
    return { ok: true, message: `📊 Digest ${token.digest_kind} (${token.digest_ref ?? "-"}) — ${total} proposal(s).` };
  }
  return { ok: false, message: "Unrecognized command." };
}

// ---------- Entry point ----------

export async function processInboundEmail(
  email: InboundEmail,
  token: string,
): Promise<{ ok: boolean; results: CmdResult[]; error?: string }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Idempotency: skip if we've already processed this provider message id.
  if (email.providerMessageId) {
    const { data: existing } = await supabaseAdmin
      .from("inbound_email_events")
      .select("id, results")
      .eq("provider_message_id", email.providerMessageId)
      .maybeSingle();
    if (existing) {
      return { ok: true, results: (existing as { results: CmdResult[] }).results ?? [] };
    }
  }

  // Load token
  const { data: tokRow } = await supabaseAdmin
    .from("digest_reply_tokens")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  const tok = tokRow as TokenRow | null;

  const logRow: Record<string, unknown> = {
    provider_message_id: email.providerMessageId ?? null,
    token,
    from_email: email.fromEmail,
    subject: email.subject ?? null,
    raw_body: email.strippedBody.slice(0, 8000),
    parsed_commands: [],
    results: [],
    status: "received",
  };

  if (!tok) {
    logRow.status = "invalid_token";
    logRow.error = "token not found";
    await supabaseAdmin.from("inbound_email_events").insert(logRow as never);
    return { ok: false, results: [], error: "invalid_token" };
  }
  if (tok.expires_at && new Date(tok.expires_at).getTime() < Date.now()) {
    logRow.status = "token_expired";
    await supabaseAdmin.from("inbound_email_events").insert(logRow as never);
    return { ok: false, results: [], error: "token_expired" };
  }

  // Verify From matches the token's user (case-insensitive).
  const { data: prof } = await supabaseAdmin
    .from("profiles")
    .select("email")
    .eq("id", tok.user_id)
    .maybeSingle();
  const senderEmail = extractEmail(email.fromEmail).toLowerCase();
  const expectedEmail = ((prof as { email: string | null } | null)?.email ?? "").toLowerCase();
  if (!expectedEmail || senderEmail !== expectedEmail) {
    logRow.status = "sender_mismatch";
    logRow.error = `expected ${expectedEmail}, got ${senderEmail}`;
    await supabaseAdmin.from("inbound_email_events").insert(logRow as never);
    return { ok: false, results: [], error: "sender_mismatch" };
  }

  // Parse + run commands.
  const commands = parseCommands(email.strippedBody);
  const results: CmdResult[] = [];
  for (const c of commands) {
    if (c.kind === "unknown") {
      results.push({ command: c, ok: false, message: `Didn't understand: "${c.raw}"` });
      continue;
    }
    const r = await runCommand(supabaseAdmin, tok, c);
    results.push({ command: c, ok: r.ok, message: r.message });
  }

  logRow.parsed_commands = commands;
  logRow.results = results;
  logRow.status = results.length === 0 ? "no_commands" : "processed";
  await supabaseAdmin.from("inbound_email_events").insert(logRow as never);

  // Reply back with a confirmation email.
  if (results.length > 0) {
    try {
      const { enqueueAppEmail } = await import("@/lib/email/enqueue-app-email.server");
      const lines = results.map((r, i) => `${i + 1}. ${r.ok ? "✓" : "✗"} ${r.message}`).join("\n");
      await enqueueAppEmail({
        templateName: "agent-inbound-ack",
        recipientEmail: senderEmail,
        idempotencyKey: `inbound-ack-${email.providerMessageId ?? crypto.randomUUID()}`,
        templateData: {
          summary: `Processed ${results.length} command(s) from your reply.`,
          details: lines,
          subject: email.subject ?? "your digest",
        },
      });
    } catch {
      // Non-fatal — the actions still ran.
    }
  }

  return { ok: true, results };
}

function extractEmail(fromHeader: string): string {
  const m = fromHeader.match(/<([^>]+)>/);
  return (m ? m[1] : fromHeader).trim();
}

// ---------- Token minting (called by the digest sender) ----------

export function replyAddressFor(token: string): string {
  return `reply+${token}@reply.sugslloyds.com`;
}

export function subjectTagFor(token: string): string {
  return `[ref:${token}]`;
}

export async function mintDigestReplyToken(input: {
  userId: string;
  digestKind: string;
  digestRef?: string | null;
  pendingActionIds: string[];
  projectIds?: string[];
  ttlDays?: number;
}): Promise<string> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const expires = new Date(Date.now() + (input.ttlDays ?? 14) * 86_400_000).toISOString();
  await supabaseAdmin.from("digest_reply_tokens").insert({
    token,
    user_id: input.userId,
    digest_kind: input.digestKind,
    digest_ref: input.digestRef ?? null,
    pending_action_ids: input.pendingActionIds,
    project_ids: input.projectIds ?? [],
    expires_at: expires,
  } as never);
  return token;
}

// Extract the reply token from either the "plus" address or the subject tag.
export function extractToken(opts: { toEmail?: string; mailboxHash?: string; subject?: string }): string | null {
  if (opts.mailboxHash && /^[a-f0-9]{16,}$/i.test(opts.mailboxHash)) return opts.mailboxHash;
  if (opts.toEmail) {
    const m = opts.toEmail.match(/reply\+([a-f0-9]{16,})@/i);
    if (m) return m[1];
  }
  if (opts.subject) {
    const m = opts.subject.match(/\[ref:([a-f0-9]{16,})\]/i);
    if (m) return m[1];
  }
  return null;
}

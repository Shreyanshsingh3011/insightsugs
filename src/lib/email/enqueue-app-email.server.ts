// Server-only helper: render a registered React Email template and enqueue
// it into the transactional_emails queue via the enqueue_email RPC.
// Mirrors the logic in src/routes/lovable/email/transactional/send.ts so
// server functions can send emails without an HTTP hop.
//
// IMPORTANT: this file may only be imported from other *.server.ts files
// or from inside a server-fn handler via `await import(...)`.

import * as React from "react";
import { render } from "react-email";
import { TEMPLATES } from "@/lib/email-templates/registry";

const SITE_NAME = "insightsugs";
const SENDER_DOMAIN = "notify.sugslloyds.com";
const FROM_DOMAIN = "sugslloyds.com";

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type EnqueueEmailInput = {
  templateName: string;
  recipientEmail: string;
  idempotencyKey?: string;
  templateData?: Record<string, unknown>;
};

export type EnqueueEmailResult =
  | { ok: true; queued: true; messageId: string }
  | { ok: false; reason: "template_not_found" | "email_suppressed" | "enqueue_failed" | "render_failed"; error?: string };

export async function enqueueAppEmail(
  input: EnqueueEmailInput,
): Promise<EnqueueEmailResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const template = TEMPLATES[input.templateName];
  if (!template) return { ok: false, reason: "template_not_found" };

  const recipient = (template.to || input.recipientEmail || "").trim();
  if (!recipient) return { ok: false, reason: "enqueue_failed", error: "missing recipient" };

  const normalized = recipient.toLowerCase();
  const messageId = crypto.randomUUID();
  const idempotencyKey = input.idempotencyKey || messageId;
  const templateData = input.templateData ?? {};

  // Suppression check (fail-closed).
  const { data: suppressed } = await supabaseAdmin
    .from("suppressed_emails")
    .select("id")
    .eq("email", normalized)
    .maybeSingle();
  if (suppressed) {
    await supabaseAdmin.from("email_send_log").insert({
      message_id: messageId,
      template_name: input.templateName,
      recipient_email: recipient,
      status: "suppressed",
    });
    return { ok: false, reason: "email_suppressed" };
  }

  // Get-or-create unsubscribe token.
  let unsubscribeToken: string;
  const { data: existing } = await supabaseAdmin
    .from("email_unsubscribe_tokens")
    .select("token, used_at")
    .eq("email", normalized)
    .maybeSingle();
  if (existing && !existing.used_at) {
    unsubscribeToken = existing.token;
  } else if (!existing) {
    const fresh = generateToken();
    await supabaseAdmin
      .from("email_unsubscribe_tokens")
      .upsert({ token: fresh, email: normalized }, { onConflict: "email", ignoreDuplicates: true });
    const { data: stored } = await supabaseAdmin
      .from("email_unsubscribe_tokens")
      .select("token")
      .eq("email", normalized)
      .maybeSingle();
    unsubscribeToken = stored?.token ?? fresh;
  } else {
    // Token exists but used — treat as suppressed.
    return { ok: false, reason: "email_suppressed" };
  }

  // Render template.
  let html: string;
  let plainText: string;
  let subject: string;
  try {
    const el = React.createElement(template.component as any, templateData);
    html = await render(el);
    plainText = await render(el, { plainText: true });
    subject = typeof template.subject === "function" ? template.subject(templateData) : template.subject;
  } catch (e) {
    return { ok: false, reason: "render_failed", error: (e as Error).message };
  }

  // Log pending, then enqueue. Stash the idempotency_key in metadata so
  // callers (e.g. status-report dialog) can look up delivery status later.
  await supabaseAdmin.from("email_send_log").insert({
    message_id: messageId,
    template_name: input.templateName,
    recipient_email: recipient,
    status: "pending",
    metadata: { idempotency_key: idempotencyKey } as never,
  });


  const { error: enqueueError } = await supabaseAdmin.rpc("enqueue_email", {
    queue_name: "transactional_emails",
    payload: {
      message_id: messageId,
      to: recipient,
      from: `${SITE_NAME} <noreply@${FROM_DOMAIN}>`,
      sender_domain: SENDER_DOMAIN,
      subject,
      html,
      text: plainText,
      purpose: "transactional",
      label: input.templateName,
      idempotency_key: idempotencyKey,
      unsubscribe_token: unsubscribeToken,
      queued_at: new Date().toISOString(),
    },
  });

  if (enqueueError) {
    await supabaseAdmin.from("email_send_log").insert({
      message_id: messageId,
      template_name: input.templateName,
      recipient_email: recipient,
      status: "failed",
      error_message: enqueueError.message,
    });
    return { ok: false, reason: "enqueue_failed", error: enqueueError.message };
  }

  return { ok: true, queued: true, messageId };
}

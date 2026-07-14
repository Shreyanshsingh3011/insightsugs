// Inbound email webhook.
//
// Configure your inbound provider (Postmark Inbound, Resend Inbound,
// SendGrid Inbound Parse, Mailgun Routes, etc.) to POST every incoming
// message to:
//
//   POST https://insightsugs.lovable.app/api/public/hooks/email-inbound
//   Authorization: Bearer <INBOUND_EMAIL_WEBHOOK_TOKEN>
//
// This route accepts a flexible JSON body — it looks for the common fields
// under both Postmark's PascalCase and Resend/SendGrid style keys.
// It requires either a `reply+<token>@...` To address or a `[ref:<token>]`
// subject tag, and that the From address matches the token's user.

import { createFileRoute } from "@tanstack/react-router";
import { processInboundEmail, extractToken } from "@/lib/agent-inbound.server";

type InboundPayload = {
  From?: string;
  from?: string;
  Sender?: string;
  To?: string;
  to?: string;
  OriginalRecipient?: string;
  Subject?: string;
  subject?: string;
  TextBody?: string;
  text?: string;
  StrippedTextReply?: string;
  MessageID?: string;
  MessageId?: string;
  messageId?: string;
  message_id?: string;
  InReplyTo?: string;
  "In-Reply-To"?: string;
  MailboxHash?: string;
  Headers?: Array<{ Name: string; Value: string }>;
  ToFull?: Array<{ Email: string; MailboxHash?: string }>;
};

function firstString(...values: Array<unknown>): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const Route = createFileRoute("/api/public/hooks/email-inbound")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.INBOUND_EMAIL_WEBHOOK_TOKEN;
        if (!secret) {
          return new Response("Server not configured", { status: 500 });
        }

        // Header-only: `Authorization: Bearer <token>`. Query strings leak
        // through access logs, proxies, and the Referer header, so we no
        // longer accept `?token=`.
        const authHeader = request.headers.get("authorization") ?? "";
        const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
        if (!bearer || !timingSafeEqual(bearer, secret)) {
          return new Response("Unauthorized", { status: 401 });
        }

        let payload: InboundPayload;
        try {
          payload = (await request.json()) as InboundPayload;
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }

        const from = firstString(payload.From, payload.from, payload.Sender);
        if (!from) return new Response("Missing From", { status: 400 });

        const toRaw = firstString(
          payload.To,
          payload.to,
          payload.OriginalRecipient,
          payload.ToFull?.[0]?.Email,
        );
        const mailboxHash = firstString(
          payload.MailboxHash,
          payload.ToFull?.[0]?.MailboxHash,
        ) ?? undefined;
        const subject = firstString(payload.Subject, payload.subject) ?? "";
        const body = firstString(payload.StrippedTextReply, payload.TextBody, payload.text) ?? "";
        const providerMessageId = firstString(
          payload.MessageID,
          payload.MessageId,
          payload.messageId,
          payload.message_id,
        );
        const inReplyTo = firstString(payload.InReplyTo, payload["In-Reply-To"]);

        const token = extractToken({
          toEmail: toRaw ?? undefined,
          mailboxHash,
          subject,
        });
        if (!token) {
          return Response.json(
            { ok: false, error: "no_reply_token" },
            { status: 200 },
          );
        }

        const result = await processInboundEmail(
          {
            providerMessageId,
            fromEmail: from,
            subject,
            strippedBody: body,
            inReplyTo,
          },
          token,
        );

        // Return 200 for auth/token/sender failures so the provider doesn't
        // retry indefinitely; the event is logged in inbound_email_events.
        return Response.json(result, { status: 200 });
      },
    },
  },
});

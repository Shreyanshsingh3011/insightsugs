import React from "react";
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
  Hr,
} from "@react-email/components";
import type { TemplateEntry } from "./registry";

interface Props {
  recipientName?: string;
  senderName?: string;
  subject?: string;
  message?: string;
  context?: string; // e.g. "Project X · Stage Y · Activity Z"
  reasonWhy?: string;
}

const AgentNotificationEmail = ({
  recipientName,
  senderName,
  subject,
  message,
  context,
  reasonWhy,
}: Props) => {
  const greeting = recipientName ? `Hi ${recipientName.split(/\s+/)[0]},` : "Hi,";
  const paragraphs = (message ?? "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{subject ?? "You have a new update"}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>{subject ?? "Update from InsightSugs"}</Heading>
          {context ? <Text style={ctxText}>{context}</Text> : null}
          <Hr style={hr} />
          <Text style={text}>{greeting}</Text>
          {paragraphs.map((p, i) => (
            <Text style={text} key={i}>
              {p}
            </Text>
          ))}
          {reasonWhy ? (
            <Section style={whyBox}>
              <Text style={whyLabel}>Why you're getting this</Text>
              <Text style={whyText}>{reasonWhy}</Text>
            </Section>
          ) : null}
          <Hr style={hr} />
          <Text style={footer}>
            {senderName ? `Sent by ${senderName} · ` : ""}InsightSugs
          </Text>
        </Container>
      </Body>
    </Html>
  );
};

export const template = {
  component: AgentNotificationEmail,
  subject: (data: Record<string, any>) =>
    (data?.subject as string) || "Update from InsightSugs",
  displayName: "Agent notification",
  previewData: {
    recipientName: "Arpita Das",
    senderName: "InsightSugs Agent",
    subject: "Nudge: Foundation works is 4 days overdue",
    context: "Project Alpha · Stage Civil · Activity Foundation works",
    message:
      "Foundation works on Project Alpha is currently 4 days past plan.\n\nCould you share the latest status and a committed recovery date today?\n\nThanks.",
    reasonWhy: "Delay in Days = 4, status open, not marked complete.",
  },
} satisfies TemplateEntry;

const main = { backgroundColor: "#ffffff", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" };
const container = { padding: "24px 28px", maxWidth: "560px", margin: "0 auto" };
const h1 = { fontSize: "20px", fontWeight: 600, color: "#0f172a", margin: "0 0 8px" };
const ctxText = { fontSize: "13px", color: "#64748b", margin: "0 0 4px" };
const text = { fontSize: "14px", color: "#0f172a", lineHeight: "1.55", margin: "0 0 12px" };
const hr = { borderColor: "#e2e8f0", margin: "16px 0" };
const whyBox = { backgroundColor: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "12px 14px", margin: "8px 0" };
const whyLabel = { fontSize: "11px", textTransform: "uppercase" as const, letterSpacing: "0.06em", color: "#64748b", margin: "0 0 4px" };
const whyText = { fontSize: "13px", color: "#334155", margin: 0 };
const footer = { fontSize: "12px", color: "#94a3b8", margin: 0 };

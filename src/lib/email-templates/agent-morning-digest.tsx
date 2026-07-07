import React from "react";
import {
  Body,
  Button,
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

interface Proposal {
  title: string;
  summary: string;
  rationale: string;
  kind: string;
  reviewUrl: string;
}

interface Props {
  recipientName?: string;
  windowHours?: number;
  proposals?: Proposal[];
  totalCount?: number;
  approvalsUrl?: string;
}

const AgentMorningDigestEmail = ({
  recipientName,
  windowHours = 24,
  proposals = [],
  totalCount = 0,
  approvalsUrl = "https://insightsugs.lovable.app/agent/approvals",
}: Props) => {
  const greeting = recipientName ? `Good morning, ${recipientName.split(/\s+/)[0]}.` : "Good morning.";
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>
        {totalCount > 0
          ? `${totalCount} agent proposals from the last ${windowHours}h are awaiting your approval.`
          : "No new agent proposals overnight."}
      </Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>DelayLens · Morning digest</Heading>
          <Text style={ctxText}>
            Autonomous agent scan · last {windowHours} hours
          </Text>
          <Hr style={hr} />
          <Text style={text}>{greeting}</Text>
          <Text style={text}>
            The overnight agent tick queued <strong>{totalCount}</strong> proposal
            {totalCount === 1 ? "" : "s"} for your review. The most urgent are shown below.
          </Text>

          {proposals.length > 0 ? (
            <Section style={listBox}>
              {proposals.map((p, i) => (
                <Section key={i} style={itemBox}>
                  <Text style={itemTitle}>{p.title}</Text>
                  <Text style={itemSummary}>{p.summary}</Text>
                  {p.rationale ? <Text style={itemRationale}>{p.rationale}</Text> : null}
                </Section>
              ))}
            </Section>
          ) : (
            <Text style={text}>Nothing to review right now — enjoy the quiet.</Text>
          )}

          {totalCount > 0 ? (
            <Section style={{ textAlign: "center", margin: "28px 0 8px" }}>
              <Button href={approvalsUrl} style={cta}>
                Review all proposals →
              </Button>
            </Section>
          ) : null}

          <Hr style={hr} />
          <Text style={footer}>
            InsightSugs · You receive this because you are a super admin. Adjust
            digest settings from Agent → Approvals.
          </Text>
        </Container>
      </Body>
    </Html>
  );
};

export const template = {
  component: AgentMorningDigestEmail,
  subject: (data: Record<string, unknown>) => {
    const n = typeof data.totalCount === "number" ? data.totalCount : 0;
    return n > 0
      ? `DelayLens · ${n} agent proposal${n === 1 ? "" : "s"} awaiting approval`
      : "DelayLens · Morning digest (nothing new)";
  },
  displayName: "Agent morning digest",
  previewData: {
    recipientName: "Ada",
    windowHours: 24,
    totalCount: 3,
    approvalsUrl: "https://insightsugs.lovable.app/agent/approvals",
    proposals: [
      {
        title: "Alert: Beam formwork",
        summary: "CRITICAL — Beam formwork (Tower 3) · owner Priya",
        rationale: "14 days overdue (TAT 10d). Suggested action: escalate + email owner.",
        kind: "create_alert",
        reviewUrl: "https://insightsugs.lovable.app/agent/approvals",
      },
      {
        title: "Alert: Slab curing",
        summary: "WARNING — Slab curing (Tower 1) · owner Rahul",
        rationale: "5 days overdue. Suggested action: nudge owner + schedule standup.",
        kind: "create_alert",
        reviewUrl: "https://insightsugs.lovable.app/agent/approvals",
      },
    ],
  },
} satisfies TemplateEntry;

const main = { backgroundColor: "#ffffff", fontFamily: "Arial, sans-serif" };
const container = { padding: "24px 28px", maxWidth: "600px" };
const h1 = { fontSize: "22px", color: "#0f172a", margin: "0 0 4px" };
const ctxText = { fontSize: "13px", color: "#64748b", margin: "0 0 8px" };
const hr = { borderColor: "#e2e8f0", margin: "16px 0" };
const text = { fontSize: "14px", color: "#0f172a", lineHeight: "22px", margin: "8px 0" };
const listBox = { margin: "12px 0" };
const itemBox = {
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  padding: "12px 14px",
  margin: "10px 0",
};
const itemTitle = { fontSize: "14px", fontWeight: 600, color: "#0f172a", margin: "0 0 4px" };
const itemSummary = { fontSize: "13px", color: "#334155", margin: "0 0 6px" };
const itemRationale = { fontSize: "12px", color: "#64748b", fontStyle: "italic", margin: 0 };
const cta = {
  backgroundColor: "#0f172a",
  color: "#ffffff",
  padding: "10px 20px",
  borderRadius: "6px",
  textDecoration: "none",
  fontSize: "14px",
  fontWeight: 600,
};
const footer = { fontSize: "11px", color: "#94a3b8", lineHeight: "16px" };

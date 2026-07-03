import React from "react";
import { Body, Container, Head, Heading, Html, Preview, Section, Text, Hr } from "@react-email/components";
import type { TemplateEntry } from "./registry";

interface Section {
  title: string;
  summary?: string;
  bullets?: string[];
}

interface Props {
  recipientName?: string;
  weekStart?: string;
  weekEnd?: string;
  scope?: "user" | "org";
  sections?: Section[];
  briefingUrl?: string;
}

const WeeklyBriefingEmail = ({ recipientName, weekStart, weekEnd, scope, sections, briefingUrl }: Props) => {
  const greeting = recipientName ? `Hi ${recipientName.split(/\s+/)[0]},` : "Hi,";
  const label = scope === "org" ? "Org-wide weekly briefing" : "Your weekly briefing";
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{`${label} · ${weekStart} → ${weekEnd}`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>{label}</Heading>
          <Text style={ctx}>{weekStart} → {weekEnd}</Text>
          <Hr style={hr} />
          <Text style={text}>{greeting}</Text>
          <Text style={text}>Here's what happened this week across the areas you can see.</Text>
          {(sections ?? []).map((s, i) => (
            <Section key={i} style={sectionBox}>
              <Text style={h2}>{s.title}</Text>
              {s.summary ? <Text style={text}>{s.summary}</Text> : null}
              {s.bullets && s.bullets.length > 0 ? (
                <ul style={ul}>
                  {s.bullets.map((b, j) => (
                    <li key={j} style={li}>{b}</li>
                  ))}
                </ul>
              ) : null}
            </Section>
          ))}
          {briefingUrl ? (
            <Text style={text}>
              Open full briefing: <a href={briefingUrl} style={link}>{briefingUrl}</a>
            </Text>
          ) : null}
          <Hr style={hr} />
          <Text style={footer}>InsightSugs · weekly briefing</Text>
        </Container>
      </Body>
    </Html>
  );
};

export const template = {
  component: WeeklyBriefingEmail,
  subject: (data: Record<string, any>) => {
    const scope = data?.scope === "org" ? "Org weekly briefing" : "Your weekly briefing";
    return `${scope} · ${data?.weekStart ?? ""} → ${data?.weekEnd ?? ""}`;
  },
  displayName: "Weekly briefing",
  previewData: {
    recipientName: "Sample User",
    weekStart: "2026-06-23",
    weekEnd: "2026-06-30",
    scope: "user",
    sections: [
      { title: "Projects & activities", summary: "3 completed, 2 overdue.", bullets: ["Foundation works completed", "Steel erection 3 days overdue"] },
      { title: "Sheets", summary: "No significant anomalies.", bullets: [] },
    ],
    briefingUrl: "https://insightsugs.lovable.app/briefings",
  },
} satisfies TemplateEntry;

const main = { backgroundColor: "#ffffff", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" };
const container = { padding: "24px 28px", maxWidth: "620px", margin: "0 auto" };
const h1 = { fontSize: "20px", fontWeight: 600, color: "#0f172a", margin: "0 0 8px" };
const h2 = { fontSize: "14px", fontWeight: 600, color: "#0f172a", margin: "0 0 6px" };
const ctx = { fontSize: "13px", color: "#64748b", margin: "0 0 4px" };
const text = { fontSize: "14px", color: "#0f172a", lineHeight: "1.55", margin: "0 0 10px" };
const sectionBox = { backgroundColor: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "12px 14px", margin: "10px 0" };
const ul = { paddingLeft: "18px", margin: "4px 0 0" };
const li = { fontSize: "13px", color: "#334155", lineHeight: "1.5", margin: "2px 0" };
const link = { color: "#2563eb", textDecoration: "underline" };
const hr = { borderColor: "#e2e8f0", margin: "16px 0" };
const footer = { fontSize: "12px", color: "#94a3b8", margin: 0 };

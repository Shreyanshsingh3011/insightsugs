import React from "react";
import { Body, Container, Head, Heading, Html, Preview, Text, Hr, Section } from "@react-email/components";
import type { TemplateEntry } from "./registry";

interface Props {
  candidateName?: string;
  reason?: string;
  reviewerName?: string;
}

const SignupRejectedEmail = ({ candidateName, reason, reviewerName }: Props) => {
  const first = candidateName ? candidateName.split(/\s+/)[0] : "there";
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>Update on your InsightSugs signup request</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>Signup request update</Heading>
          <Text style={text}>Hi {first},</Text>
          <Text style={text}>
            Thanks for requesting access to InsightSugs. After review{reviewerName ? ` by ${reviewerName}` : ""},
            your request wasn't approved at this time.
          </Text>
          {reason ? (
            <Section style={box}>
              <Text style={label}>Reason</Text>
              <Text style={value}>{reason}</Text>
            </Section>
          ) : null}
          <Text style={text}>
            If you think this was a mistake, please reply to this email or contact your project admin.
          </Text>
          <Hr style={hr} />
          <Text style={footer}>InsightSugs · Access approvals</Text>
        </Container>
      </Body>
    </Html>
  );
};

export const template = {
  component: SignupRejectedEmail,
  subject: "Update on your InsightSugs signup request",
  displayName: "Signup rejected",
  previewData: {
    candidateName: "Jane Doe",
    reason: "Not on the current allowlist",
    reviewerName: "Super Admin",
  },
} satisfies TemplateEntry;

const main = { backgroundColor: "#ffffff", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" };
const container = { padding: "24px 28px", maxWidth: "560px", margin: "0 auto" };
const h1 = { fontSize: "20px", fontWeight: 600, color: "#0f172a", margin: "0 0 12px" };
const text = { fontSize: "14px", color: "#0f172a", lineHeight: "1.55", margin: "0 0 12px" };
const box = { backgroundColor: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "12px 14px", margin: "12px 0" };
const label = { fontSize: "11px", textTransform: "uppercase" as const, letterSpacing: "0.06em", color: "#64748b", margin: "0 0 4px" };
const value = { fontSize: "14px", color: "#0f172a", margin: 0 };
const hr = { borderColor: "#e2e8f0", margin: "16px 0" };
const footer = { fontSize: "12px", color: "#94a3b8", margin: 0 };

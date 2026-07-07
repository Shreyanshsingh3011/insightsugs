import React from "react";
import { Body, Container, Head, Heading, Html, Preview, Text, Hr, Button, Section } from "@react-email/components";
import type { TemplateEntry } from "./registry";

interface Props {
  reviewerName?: string;
  candidateName?: string;
  candidateEmail?: string;
  requestedRole?: string;
  reviewUrl?: string;
}

const SignupPendingReviewEmail = ({
  reviewerName,
  candidateName,
  candidateEmail,
  requestedRole,
  reviewUrl,
}: Props) => {
  const greeting = reviewerName ? `Hi ${reviewerName.split(/\s+/)[0]},` : "Hi,";
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>New signup awaiting your review</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>New signup awaiting review</Heading>
          <Text style={text}>{greeting}</Text>
          <Text style={text}>
            A new account has been created and needs a super admin decision because it wasn't found in the allowlist.
          </Text>
          <Section style={box}>
            <Text style={label}>Name</Text>
            <Text style={value}>{candidateName || "(not provided)"}</Text>
            <Text style={label}>Email</Text>
            <Text style={value}>{candidateEmail}</Text>
            <Text style={label}>Requested role</Text>
            <Text style={value}>{requestedRole || "user"}</Text>
          </Section>
          {reviewUrl ? (
            <Section style={{ textAlign: "center", margin: "16px 0" }}>
              <Button href={reviewUrl} style={btn}>Review request</Button>
            </Section>
          ) : null}
          <Hr style={hr} />
          <Text style={footer}>InsightSugs · Approvals inbox</Text>
        </Container>
      </Body>
    </Html>
  );
};

export const template = {
  component: SignupPendingReviewEmail,
  subject: (data: Record<string, any>) =>
    `New signup awaiting review: ${data?.candidateEmail ?? ""}`.trim(),
  displayName: "Signup pending review",
  previewData: {
    reviewerName: "Super Admin",
    candidateName: "Jane Doe",
    candidateEmail: "jane@example.com",
    requestedRole: "user",
    reviewUrl: "https://insightsugs.lovable.app/agent/approvals",
  },
} satisfies TemplateEntry;

const main = { backgroundColor: "#ffffff", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" };
const container = { padding: "24px 28px", maxWidth: "560px", margin: "0 auto" };
const h1 = { fontSize: "20px", fontWeight: 600, color: "#0f172a", margin: "0 0 12px" };
const text = { fontSize: "14px", color: "#0f172a", lineHeight: "1.55", margin: "0 0 12px" };
const box = { backgroundColor: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "12px 14px", margin: "12px 0" };
const label = { fontSize: "11px", textTransform: "uppercase" as const, letterSpacing: "0.06em", color: "#64748b", margin: "8px 0 2px" };
const value = { fontSize: "14px", color: "#0f172a", margin: 0 };
const btn = { backgroundColor: "#0f172a", color: "#ffffff", padding: "10px 18px", borderRadius: "6px", fontSize: "14px", textDecoration: "none" };
const hr = { borderColor: "#e2e8f0", margin: "16px 0" };
const footer = { fontSize: "12px", color: "#94a3b8", margin: 0 };

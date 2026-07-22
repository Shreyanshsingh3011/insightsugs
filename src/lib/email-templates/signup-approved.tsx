import React from "react";
import { Body, Container, Head, Heading, Html, Preview, Text, Hr, Button, Section } from "@react-email/components";
import type { TemplateEntry } from "./registry";

interface Props {
  candidateName?: string;
  grantedRole?: string;
  appUrl?: string;
  reviewerName?: string;
}

const SignupApprovedEmail = ({ candidateName, grantedRole, appUrl, reviewerName }: Props) => {
  const first = candidateName ? candidateName.split(/\s+/)[0] : "there";
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>Your InsightSugs access has been approved</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>You're in — access approved</Heading>
          <Text style={text}>Hi {first},</Text>
          <Text style={text}>
            Good news — your InsightSugs signup was approved{reviewerName ? ` by ${reviewerName}` : ""}. You now have{" "}
            <strong>{grantedRole || "user"}</strong> access and can sign in right away.
          </Text>
          {appUrl ? (
            <Section style={{ textAlign: "center", margin: "16px 0" }}>
              <Button href={appUrl} style={btn}>Open InsightSugs</Button>
            </Section>
          ) : null}
          <Hr style={hr} />
          <Text style={footer}>InsightSugs · Access approvals</Text>
        </Container>
      </Body>
    </Html>
  );
};

export const template = {
  component: SignupApprovedEmail,
  subject: "Your InsightSugs access has been approved",
  displayName: "Signup approved",
  previewData: {
    candidateName: "Jane Doe",
    grantedRole: "user",
    appUrl: "https://insightsugs.lovable.app",
    reviewerName: "Super Admin",
  },
} satisfies TemplateEntry;

const main = { backgroundColor: "#ffffff", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" };
const container = { padding: "24px 28px", maxWidth: "560px", margin: "0 auto" };
const h1 = { fontSize: "20px", fontWeight: 600, color: "#0f172a", margin: "0 0 12px" };
const text = { fontSize: "14px", color: "#0f172a", lineHeight: "1.55", margin: "0 0 12px" };
const btn = { backgroundColor: "#0f172a", color: "#ffffff", padding: "10px 18px", borderRadius: "6px", fontSize: "14px", textDecoration: "none" };
const hr = { borderColor: "#e2e8f0", margin: "16px 0" };
const footer = { fontSize: "12px", color: "#94a3b8", margin: 0 };

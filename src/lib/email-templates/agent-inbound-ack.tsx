import React from 'react'
import { Body, Container, Head, Heading, Html, Preview, Section, Text } from '@react-email/components'
import type { TemplateEntry } from './registry'

interface Props {
  summary?: string
  details?: string
  subject?: string
}

const Email = ({ summary, details, subject }: Props) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{summary ?? 'Your email commands were processed.'}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>Commands processed</Heading>
        <Text style={p}>{summary ?? 'Your reply was processed.'}</Text>
        {subject ? (
          <Text style={meta}>Re: {subject}</Text>
        ) : null}
        <Section style={box}>
          <pre style={pre}>{details ?? ''}</pre>
        </Section>
        <Text style={foot}>
          You can reply again with commands like <code>approve #2</code>,{' '}
          <code>reject #3 dup</code>, <code>snooze #1 2d</code>, or{' '}
          <code>why is it late?</code>
        </Text>
      </Container>
    </Body>
  </Html>
)

export const template = {
  component: Email,
  subject: (d: Record<string, unknown>) =>
    `Re: ${(d.subject as string) ?? 'your digest'} — processed`,
  displayName: 'Agent inbound acknowledgement',
  previewData: {
    summary: 'Processed 2 command(s) from your reply.',
    details: '1. ✓ Approved proposal #2.\n2. ✗ No proposal #7 in this digest.',
    subject: 'Morning digest',
  },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: 'Arial, sans-serif', color: '#0f172a' }
const container = { padding: '24px 28px', maxWidth: '560px' }
const h1 = { fontSize: '20px', margin: '0 0 12px' }
const p = { fontSize: '14px', lineHeight: '22px', margin: '0 0 8px' }
const meta = { fontSize: '12px', color: '#64748b', margin: '0 0 16px' }
const box = { border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px 14px', backgroundColor: '#f8fafc' }
const pre = { margin: 0, fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: '13px', whiteSpace: 'pre-wrap' as const }
const foot = { fontSize: '12px', color: '#64748b', marginTop: '18px' }

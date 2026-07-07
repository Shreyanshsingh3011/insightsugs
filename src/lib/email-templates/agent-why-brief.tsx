import React from 'react'
import { Body, Container, Head, Heading, Html, Preview, Section, Text } from '@react-email/components'
import type { TemplateEntry } from './registry'

interface Item {
  index: number
  title: string
  project?: string | null
  owner?: string | null
  brief: string
  bullets?: string[]
  recommended?: string | null
}

interface Props {
  subject?: string
  items?: Item[]
}

const Email = ({ subject, items = [] }: Props) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>Why it's late — brief for {items.length} item(s)</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>Why it's late</Heading>
        {subject ? <Text style={meta}>Re: {subject}</Text> : null}
        {items.length === 0 ? (
          <Text style={p}>No items to brief on.</Text>
        ) : (
          items.map((it) => (
            <Section key={it.index} style={box}>
              <Text style={h2}>
                #{it.index} — {it.title}
              </Text>
              <Text style={metaSmall}>
                {[it.project, it.owner ? `owner ${it.owner}` : null].filter(Boolean).join(' · ')}
              </Text>
              <Text style={p}>{it.brief}</Text>
              {it.bullets && it.bullets.length > 0 ? (
                <ul style={ul}>
                  {it.bullets.map((b, i) => (
                    <li key={i} style={li}>{b}</li>
                  ))}
                </ul>
              ) : null}
              {it.recommended ? (
                <Text style={rec}>
                  <strong>Recommended:</strong> {it.recommended}
                </Text>
              ) : null}
            </Section>
          ))
        )}
        <Text style={foot}>
          Reply <code>approve #N</code>, <code>reject #N reason</code>, or{' '}
          <code>snooze #N 2d</code> to act.
        </Text>
      </Container>
    </Body>
  </Html>
)

export const template = {
  component: Email,
  subject: (d: Record<string, unknown>) =>
    `Why it's late — Re: ${(d.subject as string) ?? 'your digest'}`,
  displayName: 'Agent "why is it late" brief',
  previewData: {
    subject: 'Morning digest',
    items: [
      {
        index: 1,
        title: 'Foundation pour — Block A',
        project: 'Sugs Tower',
        owner: 'A. Kumar',
        brief: 'Delayed 6 days due to rebar arriving off-spec; resupply ETA Thursday.',
        bullets: ['Vendor slippage on rebar', 'Owner already escalated once', 'Downstream MEP at risk'],
        recommended: 'Approve escalation to project director.',
      },
    ],
  },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: 'Arial, sans-serif', color: '#0f172a' }
const container = { padding: '24px 28px', maxWidth: '620px' }
const h1 = { fontSize: '20px', margin: '0 0 4px' }
const h2 = { fontSize: '15px', margin: '0 0 4px', fontWeight: 600 }
const p = { fontSize: '14px', lineHeight: '22px', margin: '6px 0' }
const meta = { fontSize: '12px', color: '#64748b', margin: '0 0 16px' }
const metaSmall = { fontSize: '12px', color: '#64748b', margin: '0 0 8px' }
const rec = { fontSize: '13px', margin: '8px 0 0', color: '#0f172a' }
const box = { border: '1px solid #e2e8f0', borderRadius: '8px', padding: '14px 16px', margin: '0 0 12px', backgroundColor: '#f8fafc' }
const ul = { margin: '4px 0 4px 18px', padding: 0 }
const li = { fontSize: '13px', lineHeight: '20px', margin: '2px 0' }
const foot = { fontSize: '12px', color: '#64748b', marginTop: '18px' }

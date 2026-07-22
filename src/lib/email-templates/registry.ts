import type { ComponentType } from 'react'
import { template as agentNotification } from './agent-notification'
import { template as weeklyBriefing } from './weekly-briefing'
import { template as signupPendingReview } from './signup-pending-review'
import { template as signupApproved } from './signup-approved'
import { template as signupRejected } from './signup-rejected'
import { template as agentMorningDigest } from './agent-morning-digest'
import { template as agentInboundAck } from './agent-inbound-ack'
import { template as agentWhyBrief } from './agent-why-brief'

export interface TemplateEntry {
  component: ComponentType<any>
  subject: string | ((data: Record<string, any>) => string)
  displayName?: string
  previewData?: Record<string, any>
  /** Fixed recipient — overrides caller-provided recipientEmail when set. */
  to?: string
}

/**
 * Template registry — maps template names to their React Email components.
 * Import and register new templates here after creating them in this directory.
 */
export const TEMPLATES: Record<string, TemplateEntry> = {
  'agent-notification': agentNotification,
  'weekly-briefing': weeklyBriefing,
  'signup-pending-review': signupPendingReview,
  'signup-approved': signupApproved,
  'signup-rejected': signupRejected,
  'agent-morning-digest': agentMorningDigest,
  'agent-inbound-ack': agentInboundAck,
  'agent-why-brief': agentWhyBrief,
}


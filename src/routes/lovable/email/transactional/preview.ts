/**
 * Route: "/lovable/email/transactional/preview" (server function, POST)
 * Access: internal — gated by `Authorization: Bearer <LOVABLE_API_KEY>` exact match. Intended
 * caller: the Lovable platform's Go API (template preview tooling), not end users.
 * Purpose: renders every registered email template (@/lib/email-templates/registry) with its
 * built-in `previewData` to HTML, for preview/QA purposes only — sends nothing.
 * Data dependencies: none beyond the in-repo template registry; no database access.
 * Gotchas: templates without `previewData` are reported with status "preview_data_required"
 * rather than failing the whole request; per-template render errors are caught individually so
 * one broken template doesn't block previewing the others.
 */
import * as React from 'react'
import { render } from 'react-email'
import { createFileRoute } from '@tanstack/react-router'
import { TEMPLATES } from '@/lib/email-templates/registry'

// Renders all registered templates with their previewData.
// Gated by LOVABLE_API_KEY — only the Go API calls this.

export const Route = createFileRoute("/lovable/email/transactional/preview")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env.LOVABLE_API_KEY
        if (!apiKey) {
          return Response.json(
            { error: 'Server configuration error' },
            { status: 500 }
          )
        }

        // Verify the caller is authorized with LOVABLE_API_KEY
        const authHeader = request.headers.get('Authorization')
        const token = authHeader?.replace(/^Bearer\s+/i, '')
        if (token !== apiKey) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const templateNames = Object.keys(TEMPLATES)
        const results: Array<{
          templateName: string
          displayName: string
          subject: string
          html: string
          status: 'ready' | 'preview_data_required' | 'render_failed'
          errorMessage?: string
        }> = []

        for (const name of templateNames) {
          const entry = TEMPLATES[name]
          const displayName = entry.displayName || name

          if (!entry.previewData) {
            results.push({
              templateName: name,
              displayName,
              subject: '',
              html: '',
              status: 'preview_data_required',
            })
            continue
          }

          try {
            const html = await render(
              React.createElement(entry.component, entry.previewData)
            )
            const resolvedSubject =
              typeof entry.subject === 'function'
                ? entry.subject(entry.previewData)
                : entry.subject

            results.push({
              templateName: name,
              displayName,
              subject: resolvedSubject,
              html,
              status: 'ready',
            })
          } catch (err) {
            console.error('Failed to render template for preview', {
              template: name,
              error: err,
            })
            results.push({
              templateName: name,
              displayName,
              subject: '',
              html: '',
              status: 'render_failed',
              errorMessage: err instanceof Error ? err.message : String(err),
            })
          }
        }

        return Response.json({ templates: results })
      },
    },
  },
})

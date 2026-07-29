/**
 * Route: "/email/unsubscribe" (server function, GET + POST)
 * Access: public/unauthenticated — reached via the unsubscribe link/button embedded in
 * outbound emails. No caller-identity check beyond possession of the opaque `token` query param
 * (or form body, for RFC 8058 one-click unsubscribe).
 * Purpose: GET validates a token (without consuming it) so the unsubscribe confirmation page can
 * render state; POST atomically marks the token used and adds the associated email to
 * `suppressed_emails` so future sends are blocked.
 * Data dependencies: Supabase tables `email_unsubscribe_tokens`, `suppressed_emails` — accessed
 * via the service-role key (SUPABASE_SERVICE_ROLE_KEY), bypassing RLS.
 * Gotchas: POST must handle three content types (RFC 8058 one-click form-encoded, JSON from the
 * app's own unsubscribe page, and a bare query-param token) — see the content-type branching.
 * The update-then-check pattern on `used_at` is written to avoid a TOCTOU double-unsubscribe race.
 */
import { createClient } from '@supabase/supabase-js'
import { createFileRoute } from '@tanstack/react-router'

function redactEmail(email: string | null | undefined): string {
  if (!email) return '***'
  const [localPart, domain] = email.split('@')
  if (!localPart || !domain) return '***'
  return `${localPart[0]}***@${domain}`
}

export const Route = createFileRoute("/email/unsubscribe")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
        const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

        if (!supabaseUrl || !supabaseServiceKey) {
          return Response.json({ error: 'Server configuration error' }, { status: 500 })
        }

        // Extract token from query params
        const url = new URL(request.url)
        const token = url.searchParams.get('token')

        if (!token) {
          return Response.json({ error: 'Token is required' }, { status: 400 })
        }

        const supabase = createClient(supabaseUrl, supabaseServiceKey)

        // Look up the token
        const { data: tokenRecord, error: lookupError } = await supabase
          .from('email_unsubscribe_tokens')
          .select('*')
          .eq('token', token)
          .maybeSingle()

        if (lookupError || !tokenRecord) {
          return Response.json({ error: 'Invalid or expired token' }, { status: 404 })
        }

        if (tokenRecord.used_at) {
          return Response.json({ valid: false, reason: 'already_unsubscribed' })
        }

        return Response.json({ valid: true })
      },

      POST: async ({ request }) => {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
        const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

        if (!supabaseUrl || !supabaseServiceKey) {
          return Response.json({ error: 'Server configuration error' }, { status: 500 })
        }

        // Extract token from query params (always present for RFC 8058 one-click)
        const url = new URL(request.url)
        let token: string | null = url.searchParams.get('token')

        // Detect RFC 8058 one-click unsubscribe: POST with form-encoded body
        // containing "List-Unsubscribe=One-Click". Email clients (Gmail, Apple Mail,
        // etc.) send this when the user clicks "Unsubscribe" in the mail UI.
        const contentType = request.headers.get('content-type') ?? ''
        if (contentType.includes('application/x-www-form-urlencoded')) {
          const formText = await request.text()
          const params = new URLSearchParams(formText)
          // For one-click, token comes from query param (already set above).
          // Otherwise, token may be in the form body.
          if (!params.get('List-Unsubscribe')) {
            const formToken = params.get('token')
            if (formToken) {
              token = formToken
            }
          }
        } else {
          // JSON body (from the app's unsubscribe page)
          try {
            const body = await request.json()
            if (body.token) {
              token = body.token
            }
          } catch {
            // Fall through — token stays from query param
          }
        }

        if (!token) {
          return Response.json({ error: 'Token is required' }, { status: 400 })
        }

        const supabase = createClient(supabaseUrl, supabaseServiceKey)

        // Look up the token
        const { data: tokenRecord, error: lookupError } = await supabase
          .from('email_unsubscribe_tokens')
          .select('*')
          .eq('token', token)
          .maybeSingle()

        if (lookupError || !tokenRecord) {
          return Response.json({ error: 'Invalid or expired token' }, { status: 404 })
        }

        if (tokenRecord.used_at) {
          return Response.json({ success: false, reason: 'already_unsubscribed' })
        }

        // Atomic check-and-update to avoid TOCTOU race
        const { data: updated, error: updateError } = await supabase
          .from('email_unsubscribe_tokens')
          .update({ used_at: new Date().toISOString() })
          .eq('token', token)
          .is('used_at', null)
          .select()
          .maybeSingle()

        if (updateError) {
          console.error('Failed to mark token as used', { error: updateError, token })
          return Response.json({ error: 'Failed to process unsubscribe' }, { status: 500 })
        }

        if (!updated) {
          return Response.json({ success: false, reason: 'already_unsubscribed' })
        }

        // Add email to suppressed list (upsert to handle duplicates)
        const { error: suppressError } = await supabase
          .from('suppressed_emails')
          .upsert(
            { email: tokenRecord.email.toLowerCase(), reason: 'unsubscribe' },
            { onConflict: 'email' },
          )

        if (suppressError) {
          console.error('Failed to suppress email', {
            error: suppressError,
            email_redacted: redactEmail(tokenRecord.email),
          })
          return Response.json({ error: 'Failed to process unsubscribe' }, { status: 500 })
        }

        console.log('Email unsubscribed', {
          email_redacted: redactEmail(tokenRecord.email),
        })

        return Response.json({ success: true })
      },
    },
  },
})

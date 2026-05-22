## Problem

The DelayLens Copilot sidebar accepts a question but never returns an answer.

The shared link you sent (`depcheck.preview.emergentagent.com/.../share/...`) is a "shared map" loader screen and doesn't expose any data I can use to debug, so the diagnosis is based on the project itself.

### What I verified
- `LOVABLE_API_KEY` is present.
- The AI Gateway responds 200 to `google/gemini-3-flash-preview` with both `Authorization: Bearer …` and `Lovable-API-Key: …` headers — the gateway itself works.
- The server function `askChatbot` uses Vercel AI SDK's `generateText` via `@ai-sdk/openai-compatible`. Gemini 3 flash returns a `reasoning_details` block that this provider stack has been flaky with, and any thrown error inside the handler propagates as an opaque rejection to the client (we only show `e.message`, which is often empty for non-Error throws), so the UI ends up silent / generic.
- The handler also has no logging, so `server-function-logs` shows nothing useful.

## Fix

Rewrite `src/lib/chat.functions.ts` to call the AI Gateway directly with `fetch`, drop the AI SDK dependency for this path, and add explicit error handling.

1. **Direct gateway call** in `askChatbot`:
   - `POST https://ai.gateway.lovable.dev/v1/chat/completions`
   - Headers: `Authorization: Bearer ${process.env.LOVABLE_API_KEY}`, `Content-Type: application/json`
   - Body: `{ model: "google/gemini-3-flash-preview", messages: [system, ...history, user] }` (non-streaming)
   - Read `data.choices[0].message.content`.
2. **Robust JSON extraction**: strip ```json fences, try `JSON.parse`; on failure, return raw text as `answer` with empty citations and `action: "none"` (existing fallback behaviour, kept).
3. **Explicit error surfaces** so the UI shows something useful:
   - 429 → throw `Error("Rate limit reached. Please try again in a minute.")`
   - 402 → throw `Error("AI credits exhausted. Add credits in Settings → Workspace → Usage.")`
   - other non-OK → throw with status + body snippet
   - missing `LOVABLE_API_KEY` → throw clear message
   - wrap handler body in try/catch and `console.error` the failure so it appears in `server-function-logs`.
4. **Keep the existing return shape** (`{ answer, citations, action }`) so `src/routes/index.tsx` (Copilot, quick actions, runAction) needs no changes.
5. **Client toast on failure**: in `Copilot.sendQ`, also `toast.error(e.message)` alongside the inline assistant bubble so the user sees the reason.

### Files touched
- `src/lib/chat.functions.ts` — rewritten handler, same exported signature.
- `src/routes/index.tsx` — one-line `toast.error` in the chat `catch`.

No schema, route, or dependency changes. `@ai-sdk/openai-compatible` and `ai` stay installed (used nowhere else critical right now; leaving them avoids unrelated build churn).

## Verification

- After the change, send "hello" in the Copilot — expect a real assistant reply.
- Trigger a known-bad path (temporarily mis-spell the model) and confirm the error toast + `server-function-logs` show the reason.
- Confirm quick actions (Predict at-risk, Top dependencies, Export PDF/CSV) still work and `action` still triggers the export.
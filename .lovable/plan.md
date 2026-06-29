# Proposed AI Enhancements

Here's what I'd add to turn the current app into a fully-featured AI workspace. Pick any combination and I'll build them after approval.

## 1. Proactive Intelligence (not just reactive Q&A)
- **Auto-Insights digest**: On sheet load, Gemini generates 5–7 "things you should know" cards (anomalies, trends, outliers, top movers) — no question needed.
- **Scheduled insights**: Daily/weekly AI summary per sheet, delivered to dashboard + email.
- **Anomaly alerts**: Background job flags rows that deviate >2σ from column norms or break user-defined rules ("alert if delay > 7 days").

## 2. Conversational Depth
- **Chat threads with memory**: Persisted conversations per sheet/document, so follow-ups ("and filter that by last month") work naturally. Currently each query is stateless.
- **Suggested follow-up questions**: After every Copilot answer, show 3 context-aware next questions.
- **Voice input + spoken answers**: Mic button → speech-to-text → Copilot → optional text-to-speech reply.

## 3. Actionable AI (write, not just read)
- **AI-generated charts on demand**: "Show me sales by region as a bar chart" → Copilot returns a real rendered chart, not just text.
- **Export to report**: "Summarize this sheet as a PDF brief" → one-click branded PDF/PPT export.
- **Email/Slack/WhatsApp drafts**: "Draft a status email to the project owner about delays" → editable draft pre-filled with sheet facts.
- **Bulk row actions via natural language**: "Mark all rows where status = pending and date < today as overdue" (with confirm step).

## 4. Cross-Sheet & Cross-Doc Intelligence
- **Global Copilot mode**: Ask one question across ALL sheets + documents at once (currently sheet-locked).
- **Auto-join detection**: Detect shared keys between sheets (item_code, store_id) and let Copilot answer relational questions ("sales for items in low-stock list").
- **Document ↔ sheet linking**: AI links a contract PDF to the project rows it references.

## 5. Comparison & Forecasting
- **Time-series forecasting**: For any numeric column with dates, Gemini + simple regression projects next 4/12 weeks.
- **Scenario / what-if**: "What if delays drop 20%?" → recomputed KPIs.
- **Period comparison**: Auto "this month vs last month" deltas on every KPI.

## 6. Personalization & Roles
- **Personal Copilot pinning**: Pin frequent questions; one-click re-run.
- **Role-aware dashboard**: Different default KPIs/tabs for super_admin vs admin vs viewer.
- **My focus view**: "Only show me rows where I'm the owner / dependent."

## 7. Trust & Explainability
- **"Show the math" toggle**: Every number → click to see the exact rows + operation used (extends the current drill-down).
- **Confidence badges**: High / Medium / Low based on sample size and operation type.
- **Citations panel**: Sidebar listing every row/doc cited in the current answer, clickable.

## 8. Ingestion Power-ups
- **Drag-drop CSV/XLSX upload** (not just URLs).
- **Image / screenshot ingestion**: Photo of a printed table → OCR via Gemini → structured rows.
- **Email-to-sheet**: Forward an email to a project address → AI extracts rows.
- **Auto-refresh schedule** per API/sheet link (every 1h / 6h / 24h).

## 9. Collaboration
- **Share an answer**: Public/internal link to a Copilot response with its citations frozen.
- **Comments on rows**: Mention teammates; AI summarizes the thread.
- **Activity feed**: "X asked Copilot about Y, got Z" so the team learns from each other.

## 10. Quality-of-life
- **Markdown rendering in Copilot** (tables, bold, lists) — confirm it's enabled everywhere.
- **Streaming responses** (token-by-token) instead of waiting for full reply.
- **Stop / regenerate** buttons.
- **Dark mode polish + keyboard shortcuts** (`/` to focus Copilot, `g s` go to sheets).

---

## My recommended first batch (highest impact, ~1 build cycle)

1. **Auto-Insights digest** on sheet open (proactive)
2. **Chat threads with memory + suggested follow-ups** (conversational depth)
3. **Streaming responses + markdown rendering + stop/regenerate** (UX baseline every AI tool has)
4. **AI-generated charts on demand** (actionable)
5. **"Show the math" citations panel** (trust)

Tell me:
- Which numbered items (or the recommended batch) you want built
- Anything to drop or add

I'll implement once you confirm.
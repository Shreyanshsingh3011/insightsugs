## Document Hub + Document-Grounded Co-pilot

Builds two new top-level features inside the existing authenticated app shell. No existing pages, routes, or RLS are modified — the sidebar gets two new entries.

### Sidebar additions (under existing nav)
- **Documents** → `/documents`
- **Co-pilot** → `/copilot`

---

### 1. Storage & schema

**Storage bucket** `documents` (private). Files stored at `userId/folderId/<uuid>.<ext>`.

**New tables (all RLS-scoped to the uploader; admins/super_admin can read everything via existing `is_admin_or_super`)**

- `doc_folders` — `id, name, parent_id, owner_id, created_at`
  - Seeded categories per user on first visit: PERT charts, Rental formats, JMC formats, Billing formats, Customer letters, Govt-agency letters, Time-extension requests.
- `documents` — `id, folder_id, owner_id, name, mime_type, size_bytes, storage_path, status (pending|processing|ready|failed), summary text, key_points jsonb, created_at`
- `document_chunks` — `id, document_id, owner_id, chunk_index, content text, embedding vector(768), token_count, page_no`
  - Index: `hnsw (embedding vector_cosine_ops)`
- `copilot_messages` — `id, user_id, role (user|assistant), content text, citations jsonb, scope jsonb, created_at` (one conversation per user — no thread table)

**RLS principle:** every table scoped to `owner_id = auth.uid()` for read/write, plus `is_admin_or_super(auth.uid())` for read. Storage policies mirror this on the `documents` bucket.

**pgvector** extension enabled. SQL function `match_doc_chunks(query_embedding, user_id, scope_folder_id, scope_document_id, match_count)` runs cosine similarity scoped to that user's accessible chunks and the chosen scope.

---

### 2. Upload + parse pipeline (server functions)

`src/lib/documents.functions.ts` (`createServerFn` + Lovable AI Gateway):

- `uploadDocument` — accepts file metadata, returns signed upload URL; client uploads directly to Storage; then calls `processDocument`.
- `processDocument(documentId)` — runs server-side:
  1. Download file from Storage.
  2. **Extract text** by mime type:
     - `text/*`, `md` → read directly.
     - `pdf` → `pdf-parse` for text-based PDFs; if extracted text is < ~200 chars, treat as scanned and fall back to Lovable AI multimodal OCR (`google/gemini-2.5-flash`) page-by-page.
     - `docx` → `mammoth` → plain text.
     - images (`png/jpg/webp`) → Lovable AI multimodal OCR.
  3. **Chunk** ~1000 chars with 150 overlap, tagging `page_no` where available.
  4. **Embed** each chunk via Lovable AI Embeddings (`google/gemini-embedding-001`, dimensions 768 → matches `vector(768)` column).
  5. **Summarize** with `generateText` (`google/gemini-3-flash-preview`) using `Output.object({ summary, key_points: string[] })`.
  6. Update `documents.status = ready` and persist `summary`, `key_points`.
- `deleteDocument`, `listFolders`, `listDocuments`, `getDocumentDetails`.

Errors set `status = failed` and surface the message to the UI.

---

### 3. Document Hub UI — `/documents`

- **Left rail:** folder tree (seeded categories + user-created). New folder / rename / delete.
- **Main pane:** file grid/table — name, type icon, size, uploaded date, status badge (`processing` shows shimmer, `failed` shows reason).
- **Drop-zone uploader** (multi-file). Accepts `.pdf, .doc, .docx, .txt, .md, .png, .jpg, .jpeg, .webp` up to 20 MB each.
- **Detail drawer** on row click: file preview/download link, AI-generated **Summary**, **Key points**, and a "Ask co-pilot about this doc" button (deep-links to `/copilot?documentId=…`).

---

### 4. Co-pilot UI — `/copilot`

Built with AI Elements (`conversation`, `message`, `prompt-input`, `shimmer`):

- **Scope picker** above the composer: `All my documents` (default) / pick folder / pick a single document. Stored in URL query so deep-links work.
- **One conversation per user**, persisted in `copilot_messages`; "Clear conversation" button wipes it.
- **Streaming server route** `src/routes/api/copilot.ts` (POST):
  1. Verify user; load last N turns from `copilot_messages`.
  2. Embed the latest user message.
  3. `match_doc_chunks` with current scope → top-K (K=6) chunks.
  4. Build a strict system prompt: *"Answer ONLY from the provided context. If the answer isn't in the context, reply: 'I couldn't find that in your documents.' Cite sources inline as [1], [2]…"*
  5. `streamText` with `google/gemini-3-flash-preview`, context appended as numbered snippets with `{document_name, page_no}`.
  6. On `onFinish`, persist user+assistant turns with `citations` (the resolved chunk → document mapping).
- **Citations panel** under each assistant message: numbered chips that open the source document's detail drawer.
- **No general-knowledge fallback** — the prompt + low temperature enforce grounding; if `match_doc_chunks` returns nothing, the route short-circuits with the "couldn't find" message and no LLM call.

---

### 5. Access control

- Document & chunk RLS already restricts to owner + admin/super_admin.
- `match_doc_chunks` runs as `security definer` but filters by the **caller's `auth.uid()`** passed in explicitly, so co-pilot retrieval can never leak another user's chunks.
- Admins continue to see all docs; their co-pilot can answer across everything they're allowed to read.

---

### 6. Technical notes

- `pdf-parse`, `mammoth`, and the Lovable AI SDK (`ai`, `@ai-sdk/openai-compatible`) added as deps; all called only inside `.functions.ts` / `routes/api/*` (server-only).
- OCR uses the gateway's multimodal model — no extra OCR binary, works inside the Cloudflare Worker runtime.
- Lovable AI Gateway helper placed at `src/lib/ai-gateway.server.ts` per the gateway knowledge.
- AI Elements installed via `bun x ai-elements@latest add conversation message prompt-input shimmer`.

---

### Out of scope (will not change)
- Existing Dashboard, Projects, Activities, Holidays, Users, Audit, login, RLS on those tables.
- No edits to `auth`, `storage` policies on other buckets, or existing edge functions.
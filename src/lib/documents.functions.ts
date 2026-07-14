import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  getAdminSupabase,
  extractText,
  chunkText,
  embedTexts,
  summarize,
  toPgVector,
} from "./documents.server";
import { isRecoverableDataReadError } from "./transient-errors";

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("is_admin_or_super", { _user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Only admins can perform this action");
}

export const deleteFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase } = context as { supabase: any };
    const { error } = await supabase.rpc("delete_doc_folder", { _folder_id: data.id });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ----- Folders ---------------------------------------------------------------

export const listFolders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    try {
      // ensure defaults exist; if the backend is warming up, the list can still render empty.
      const seedResult = await supabase.rpc("seed_default_doc_folders", { _user_id: userId });
      if (seedResult?.error && !isRecoverableDataReadError(seedResult.error)) {
        throw new Error(seedResult.error.message);
      }
      const { data, error } = await supabase
        .from("doc_folders")
        .select("id,name,parent_id,created_at")
        .order("name");
      if (error) return { folders: [], degraded: true, reason: error.message };
      return { folders: data ?? [] };
    } catch (e: any) {
      return { folders: [], degraded: true, reason: String(e?.message || e || "Document folders unavailable") };
    }
  });

export const createFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { name: string; parent_id?: string | null }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const name = data.name.trim().slice(0, 80);
    if (!name) throw new Error("Folder name required");
    const { data: row, error } = await supabase
      .from("doc_folders")
      .insert({ name, parent_id: data.parent_id ?? null, owner_id: userId })
      .select("id,name,parent_id,created_at")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

// ----- Documents -------------------------------------------------------------

export const listDocuments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id?: string | null } = {}) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const bootstrapSuperAdminEmails = new Set(["shreyansh.singh3011@gmail.com", "yash@sugslloyds.com"]);
    const claimEmail = String((context as any).claims?.email ?? "").trim().toLowerCase();
    const isBootstrapSuper = bootstrapSuperAdminEmails.has(claimEmail);
    const isAdminUser = async () => {
      if (isBootstrapSuper) return true;
      try {
        const { data: isAdmin } = await supabase.rpc("is_admin_or_super", { _user_id: userId });
        if (isAdmin) return true;
      } catch {
        // Continue to backend-auth lookup below; schema-cache hiccups must not hide super-admin documents.
      }
      try {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(userId);
        const email = String(authUser?.user?.email ?? "").trim().toLowerCase();
        return bootstrapSuperAdminEmails.has(email);
      } catch {
        return false;
      }
    };
    const adminDocumentRows = async () => {
      if (!(await isAdminUser())) return null;
      try {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        let q = supabaseAdmin
          .from("documents")
          .select("id,name,mime_type,size_bytes,status,summary,key_points,folder_id,created_at,page_count,status_error,visibility,owner_id")
          .order("created_at", { ascending: false });
        if (data.folder_id) q = q.eq("folder_id", data.folder_id);
        const { data: rows, error } = await q;
        if (error) throw error;
        return rows ?? [];
      } catch (error) {
        console.warn("Admin document list fallback failed.", error);
        return null;
      }
    };
    try {
      let q = supabase
        .from("documents")
        .select("id,name,mime_type,size_bytes,status,summary,key_points,folder_id,created_at,page_count,status_error,visibility,owner_id")
        .order("created_at", { ascending: false });
      if (data.folder_id) q = q.eq("folder_id", data.folder_id);
      const { data: rows, error } = await q;
      let effectiveRows = rows ?? [];
      let degraded = false;
      if (error || effectiveRows.length === 0) {
        const fallbackRows = await adminDocumentRows();
        if (fallbackRows && fallbackRows.length > 0) {
          effectiveRows = fallbackRows;
          degraded = true;
        } else if (error) {
          return { documents: [], degraded: true, reason: String(error.message || "Documents unavailable") };
        }
      }
      const ids = effectiveRows.filter((r: any) => r.visibility === "shared").map((r: any) => r.id);
      const shareCounts = new Map<string, number>();
      if (ids.length > 0) {
        try {
          const { data: shares } = await supabase
            .from("document_shares")
            .select("document_id")
            .in("document_id", ids);
          for (const s of shares ?? []) {
            shareCounts.set(s.document_id, (shareCounts.get(s.document_id) ?? 0) + 1);
          }
        } catch { /* non-fatal */ }
      }
      return {
        documents: effectiveRows.map((r: any) => ({
          ...r,
          share_count: shareCounts.get(r.id) ?? 0,
          is_owner: r.owner_id === userId,
        })),
        degraded,
      };
    } catch (e: any) {
      return { documents: [], degraded: true, reason: String(e?.message || e || "Documents unavailable") };
    }
  });


export const getDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase } = context as { supabase: any };
    const { data: row, error } = await supabase
      .from("documents")
      .select("*")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const deleteDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase } = context as { supabase: any };
    const { data: doc, error: gerr } = await supabase
      .from("documents")
      .select("id,storage_path")
      .eq("id", data.id)
      .single();
    if (gerr) throw new Error(gerr.message);
    await supabase.storage.from("documents").remove([doc.storage_path]).catch(() => {});
    const { error } = await supabase.from("documents").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ----- Register + process ----------------------------------------------------
// Client uploads to storage directly (RLS-scoped), then calls this fn with the
// resulting storage_path. We insert the row and synchronously process it.

export const registerAndProcessDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      name: string;
      mime_type: string;
      size_bytes: number;
      storage_path: string;
      folder_id?: string | null;
      visibility?: "private" | "public" | "shared";
      shared_user_ids?: string[];
    }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertAdmin(supabase, userId);

    const visibility = data.visibility ?? "private";
    const sharedIds =
      visibility === "shared" ? Array.from(new Set(data.shared_user_ids ?? [])) : [];

    const { data: inserted, error: ierr } = await supabase
      .from("documents")
      .insert({
        owner_id: userId,
        folder_id: data.folder_id ?? null,
        name: data.name.slice(0, 200),
        mime_type: data.mime_type,
        size_bytes: data.size_bytes,
        storage_path: data.storage_path,
        status: "processing",
        visibility,
      })
      .select("id")
      .single();
    if (ierr) throw new Error(ierr.message);

    if (sharedIds.length > 0) {
      await supabase.from("document_shares").insert(
        sharedIds.map((uid) => ({ document_id: inserted.id, user_id: uid, created_by: userId })),
      );
    }


    const docId = inserted.id as string;
    const admin = getAdminSupabase();

    try {
      const { data: file, error: dlErr } = await admin.storage
        .from("documents")
        .download(data.storage_path);
      if (dlErr || !file) throw new Error(dlErr?.message ?? "download failed");
      const buf = await file.arrayBuffer();

      const ex = await extractText(buf, data.mime_type, data.name);
      const chunks = chunkText(ex.pages);

      if (chunks.length === 0) {
        await admin
          .from("documents")
          .update({
            status: "ready",
            page_count: ex.pageCount,
            summary: "No text could be extracted from this document.",
            key_points: [],
          })
          .eq("id", docId);
        return { id: docId, status: "ready" };
      }

      // For very large documents, cap chunk count to keep processing within
      // edge-function time limits. We still summarise from the full text.
      const MAX_CHUNKS = 1500;
      let toEmbed = chunks;
      if (chunks.length > MAX_CHUNKS) {
        const stride = chunks.length / MAX_CHUNKS;
        toEmbed = Array.from({ length: MAX_CHUNKS }, (_, i) => chunks[Math.floor(i * stride)]);
      }

      const embeddings = await embedTexts(toEmbed.map((c) => c.content));
      const rows = toEmbed.map((c, i) => ({
        document_id: docId,
        owner_id: userId,
        chunk_index: c.index,
        content: c.content,
        page_no: c.pageNo,
        token_count: Math.ceil(c.content.length / 4),
        embedding: toPgVector(embeddings[i] ?? []),
      }));
      // Bigger batches make large-doc inserts dramatically faster.
      const INSERT_BATCH = 250;
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const { error: cerr } = await admin
          .from("document_chunks")
          .insert(rows.slice(i, i + INSERT_BATCH));
        if (cerr) throw new Error(cerr.message);
      }

      const allText = ex.pages.map((p) => p.text).join("\n\n");
      const s = await summarize(allText, data.name);

      await admin
        .from("documents")
        .update({
          status: "ready",
          page_count: ex.pageCount,
          summary: s.summary,
          key_points: s.key_points,
        })
        .eq("id", docId);

      return { id: docId, status: "ready" };
    } catch (e: any) {
      await admin
        .from("documents")
        .update({ status: "failed", status_error: String(e?.message ?? e).slice(0, 500) })
        .eq("id", docId);
      throw e;
    }
  });

// ----- Sharing / visibility --------------------------------------------------

export const listShareableUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertAdmin(supabase, userId);
    const admin = getAdminSupabase();
    const { data, error } = await admin
      .from("profiles")
      .select("id, full_name, email")
      .order("full_name", { ascending: true });
    if (error) throw new Error(error.message);
    return { users: (data ?? []).filter((u: any) => u.id !== userId) };
  });

export const getDocumentShares = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertAdmin(supabase, userId);
    const { data: rows, error } = await supabase
      .from("document_shares")
      .select("user_id")
      .eq("document_id", data.id);
    if (error) throw new Error(error.message);
    return { user_ids: (rows ?? []).map((r: any) => r.user_id as string) };
  });

export const updateDocumentVisibility = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      id: string;
      visibility: "private" | "public" | "shared";
      shared_user_ids?: string[];
    }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    await assertAdmin(supabase, userId);
    const admin = getAdminSupabase();
    const { error: uerr } = await admin
      .from("documents")
      .update({ visibility: data.visibility })
      .eq("id", data.id);
    if (uerr) throw new Error(uerr.message);
    await admin.from("document_shares").delete().eq("document_id", data.id);
    if (data.visibility === "shared") {
      const ids = Array.from(new Set(data.shared_user_ids ?? []));
      if (ids.length > 0) {
        const { error: ierr } = await admin.from("document_shares").insert(
          ids.map((uid) => ({ document_id: data.id, user_id: uid, created_by: userId })),
        );
        if (ierr) throw new Error(ierr.message);
      }
    }
    return { ok: true };
  });

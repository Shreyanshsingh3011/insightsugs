import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useRef, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useSession, useIsAdmin } from "@/hooks/useSession";
import {
  listFolders,
  createFolder,
  listDocuments,
  deleteDocument,
  getDocument,
  registerAndProcessDocument,
  deleteFolder,
} from "@/lib/documents.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Folder, FolderPlus, FileText, Upload, Trash2, Loader2, Sparkles, X,
  ChevronRight, ChevronDown, FolderTree,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/documents")({
  component: DocumentsPage,
});

const ACCEPT =
  ".pdf,.docx,.doc,.txt,.md,.csv,.png,.jpg,.jpeg,.webp,application/pdf";

type FolderRow = { id: string; name: string; parent_id: string | null; created_at: string };

function buildTree(folders: FolderRow[]) {
  const children: Record<string, FolderRow[]> = {};
  for (const f of folders) {
    const key = f.parent_id ?? "__root__";
    (children[key] ||= []).push(f);
  }
  for (const k of Object.keys(children)) children[k].sort((a, b) => a.name.localeCompare(b.name));
  return children;
}

function FolderTreeNode({
  folder, depth, activeFolder, setActive, expanded, toggle, tree,
  onNewChild, onDelete, canDelete,
}: {
  folder: FolderRow; depth: number; activeFolder: string | null;
  setActive: (id: string) => void;
  expanded: Set<string>; toggle: (id: string) => void;
  tree: Record<string, FolderRow[]>;
  onNewChild: (parentId: string) => void;
  onDelete: (id: string) => void;
  canDelete: boolean;
}) {
  const kids = tree[folder.id] ?? [];
  const isOpen = expanded.has(folder.id);
  const isActive = activeFolder === folder.id;
  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded-md px-1.5 py-1 text-sm hover:bg-accent ${isActive ? "bg-accent font-medium" : ""}`}
        style={{ paddingLeft: 6 + depth * 12 }}
      >
        <button
          className="grid h-5 w-5 place-items-center text-muted-foreground hover:text-foreground"
          onClick={() => toggle(folder.id)}
          aria-label={isOpen ? "Collapse" : "Expand"}
        >
          {kids.length > 0 ? (isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />) : <span className="inline-block h-3.5 w-3.5" />}
        </button>
        <button
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setActive(folder.id)}
        >
          <Folder className="h-4 w-4 shrink-0" />
          <span className="truncate">{folder.name}</span>
        </button>
        <div className="flex opacity-0 transition group-hover:opacity-100">
          <button
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            title="New sub-folder"
            onClick={(e) => { e.stopPropagation(); onNewChild(folder.id); }}
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
          {canDelete && (
            <button
              className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title="Delete folder"
              onClick={(e) => { e.stopPropagation(); onDelete(folder.id); }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      {isOpen && kids.map((k) => (
        <FolderTreeNode
          key={k.id} folder={k} depth={depth + 1}
          activeFolder={activeFolder} setActive={setActive}
          expanded={expanded} toggle={toggle} tree={tree}
          onNewChild={onNewChild} onDelete={onDelete} canDelete={canDelete}
        />
      ))}
    </div>
  );
}

function DocumentsPage() {
  const { userId } = useSession();
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const foldersFn = useServerFn(listFolders);
  const docsFn = useServerFn(listDocuments);
  const newFolderFn = useServerFn(createFolder);
  const delFn = useServerFn(deleteDocument);
  const getDocFn = useServerFn(getDocument);
  const registerFn = useServerFn(registerAndProcessDocument);
  const delFolderFn = useServerFn(deleteFolder);

  const folders = useQuery({
    queryKey: ["doc-folders"],
    queryFn: () => foldersFn({ data: undefined as any }),
  });
  const docs = useQuery({
    queryKey: ["documents", activeFolder],
    queryFn: () => docsFn({ data: { folder_id: activeFolder } }),
  });
  const doc = useQuery({
    queryKey: ["document", selectedDocId],
    enabled: !!selectedDocId,
    queryFn: () => getDocFn({ data: { id: selectedDocId! } }),
  });

  const createMu = useMutation({
    mutationFn: async (v: { name: string; parent_id: string | null }) =>
      newFolderFn({ data: v }),
    onSuccess: (row: any) => {
      qc.invalidateQueries({ queryKey: ["doc-folders"] });
      if (row?.parent_id) setExpanded((s) => new Set(s).add(row.parent_id));
    },
  });
  const delDocMu = useMutation({
    mutationFn: async (id: string) => delFn({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["documents"] });
      setSelectedDocId(null);
    },
  });
  const delFolderMu = useMutation({
    mutationFn: async (id: string) => delFolderFn({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["doc-folders"] });
      setActiveFolder(null);
    },
    onError: (e: any) => alert(e?.message ?? "Delete failed"),
  });

  const tree = useMemo(
    () => buildTree((folders.data?.folders ?? []) as FolderRow[]),
    [folders.data],
  );
  const roots = tree["__root__"] ?? [];

  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<{ name: string; status: string }[]>([]);

  async function handleFiles(files: FileList | null) {
    if (!isAdmin) return;
    if (!files || !userId) return;
    const arr = Array.from(files);
    setUploading(arr.map((f) => ({ name: f.name, status: "uploading" })));
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i];
      try {
        const ext = f.name.split(".").pop() ?? "bin";
        const path = `${userId}/${activeFolder ?? "root"}/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from("documents")
          .upload(path, f, { contentType: f.type || "application/octet-stream" });
        if (upErr) throw upErr;
        setUploading((u) => u.map((x, j) => (j === i ? { ...x, status: "processing" } : x)));
        await registerFn({
          data: {
            name: f.name,
            mime_type: f.type || "application/octet-stream",
            size_bytes: f.size,
            storage_path: path,
            folder_id: activeFolder,
          },
        });
        setUploading((u) => u.map((x, j) => (j === i ? { ...x, status: "done" } : x)));
      } catch (e: any) {
        setUploading((u) =>
          u.map((x, j) => (j === i ? { ...x, status: `error: ${e.message ?? e}` } : x)),
        );
      }
    }
    qc.invalidateQueries({ queryKey: ["documents"] });
    setTimeout(() => setUploading([]), 2500);
  }

  const promptNewChild = (parentId: string | null) => {
    const n = window.prompt("Folder name");
    if (n) createMu.mutate({ name: n, parent_id: parentId });
  };
  const confirmDeleteFolder = (id: string) => {
    if (confirm("Delete this folder? Only empty folders can be deleted.")) {
      delFolderMu.mutate(id);
    }
  };
  const toggleExpand = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  return (
    <main className="grid h-[calc(100vh-3.5rem)] grid-cols-1 md:grid-cols-[280px_1fr_360px]">
      {/* Folder rail */}
      <aside className="border-r border-border bg-card/40 p-3 overflow-y-auto">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <FolderTree className="h-3.5 w-3.5" /> Folders
          </h2>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => promptNewChild(null)}
            title="New top-level folder"
          >
            <FolderPlus className="h-4 w-4" />
          </Button>
        </div>
        <button
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent ${
            activeFolder === null ? "bg-accent font-medium" : ""
          }`}
          onClick={() => setActiveFolder(null)}
        >
          <Folder className="h-4 w-4" /> All documents
        </button>
        <div className="mt-1 space-y-0.5">
          {roots.map((f) => (
            <FolderTreeNode
              key={f.id} folder={f} depth={0}
              activeFolder={activeFolder} setActive={setActiveFolder}
              expanded={expanded} toggle={toggleExpand} tree={tree}
              onNewChild={promptNewChild} onDelete={confirmDeleteFolder}
              canDelete={isAdmin}
            />
          ))}
        </div>
      </aside>

      {/* File list */}
      <section className="flex min-w-0 flex-col">
        <div
          className="flex items-center justify-between border-b border-border p-4"
          onDragOver={(e) => { if (isAdmin) e.preventDefault(); }}
          onDrop={(e) => {
            if (!isAdmin) return;
            e.preventDefault();
            handleFiles(e.dataTransfer.files);
          }}
        >
          <div>
            <h1 className="text-lg font-semibold">Document hub</h1>
            <p className="text-xs text-muted-foreground">
              {isAdmin ? "Upload, organize, and chat with your documents." : "Browse and read documents shared by your team."}
            </p>
          </div>
          {isAdmin && (
            <div className="flex items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                multiple
                accept={ACCEPT}
                className="hidden"
                onChange={(e) => handleFiles(e.target.files)}
              />
              <Button onClick={() => fileInput.current?.click()}>
                <Upload className="mr-2 h-4 w-4" /> Upload
              </Button>
            </div>
          )}
        </div>

        {uploading.length > 0 && (
          <div className="space-y-1 border-b border-border bg-muted/30 p-3 text-xs">
            {uploading.map((u, i) => (
              <div key={i} className="flex items-center gap-2">
                {u.status === "done" ? (
                  <Badge variant="secondary">Done</Badge>
                ) : u.status.startsWith("error") ? (
                  <Badge variant="destructive">Error</Badge>
                ) : (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
                <span className="truncate">{u.name}</span>
                <span className="text-muted-foreground">{u.status}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {docs.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : docs.data?.documents.length === 0 ? (
            <div className="grid place-items-center py-20 text-center">
              <FileText className="mb-3 h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm font-medium">No documents here yet</p>
              <p className="text-xs text-muted-foreground">
                {isAdmin ? "Drag & drop files or click Upload." : "Nothing has been shared in this folder yet."}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {docs.data?.documents.map((d: any) => (
                <button
                  key={d.id}
                  onClick={() => setSelectedDocId(d.id)}
                  className={`group rounded-lg border border-border bg-card p-3 text-left transition hover:border-primary/40 hover:shadow-sm ${
                    selectedDocId === d.id ? "border-primary/60 ring-1 ring-primary/30" : ""
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{d.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {(d.size_bytes / 1024).toFixed(0)} KB ·{" "}
                        {new Date(d.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <StatusBadge status={d.status} />
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Detail drawer */}
      <aside className="hidden border-l border-border bg-card/40 md:flex md:flex-col">
        {!selectedDocId ? (
          <div className="grid flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">
            <div>
              <Sparkles className="mx-auto mb-2 h-6 w-6" />
              Select a document to see its summary and key points.
            </div>
          </div>
        ) : doc.isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : doc.data ? (
          <>
            <div className="flex items-start justify-between border-b border-border p-4">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold">{doc.data.name}</h3>
                <p className="text-xs text-muted-foreground">
                  {doc.data.mime_type} · {(doc.data.size_bytes / 1024).toFixed(0)} KB
                </p>
              </div>
              <div className="flex gap-1">
                {isAdmin && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => {
                      if (confirm("Delete this document?")) delDocMu.mutate(doc.data.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => setSelectedDocId(null)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm">
              <div>
                <StatusBadge status={doc.data.status} />
                {doc.data.status_error && (
                  <p className="mt-2 text-xs text-destructive">{doc.data.status_error}</p>
                )}
              </div>
              {doc.data.summary && (
                <div>
                  <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Summary
                  </h4>
                  <p className="leading-relaxed">{doc.data.summary}</p>
                </div>
              )}
              {Array.isArray(doc.data.key_points) && doc.data.key_points.length > 0 && (
                <div>
                  <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Key points
                  </h4>
                  <ul className="list-disc space-y-1 pl-5">
                    {doc.data.key_points.map((k: string, i: number) => (
                      <li key={i}>{k}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </>
        ) : null}
      </aside>
    </main>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "ready") return <Badge variant="secondary">Ready</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  return (
    <Badge variant="outline" className="gap-1">
      <Loader2 className="h-3 w-3 animate-spin" /> {status}
    </Badge>
  );
}

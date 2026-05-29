import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/hooks/useSession";
import { listFolders, listDocuments, registerAndProcessDocument } from "@/lib/documents.functions";
import {
  listCopilotMessages,
  sendCopilotMessage,
  clearCopilotConversation,
} from "@/lib/copilot.functions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Send, Loader2, Upload, Trash2, FileText, Paperclip } from "lucide-react";

export const Route = createFileRoute("/_authenticated/copilot")({
  component: CopilotPage,
});

const ACCEPT = ".pdf,.docx,.doc,.txt,.md,.csv,.png,.jpg,.jpeg,.webp,application/pdf";

function CopilotPage() {
  const { userId } = useSession();
  const qc = useQueryClient();

  const foldersFn = useServerFn(listFolders);
  const docsFn = useServerFn(listDocuments);
  const msgsFn = useServerFn(listCopilotMessages);
  const sendFn = useServerFn(sendCopilotMessage);
  const clearFn = useServerFn(clearCopilotConversation);
  const registerFn = useServerFn(registerAndProcessDocument);

  const folders = useQuery({
    queryKey: ["doc-folders"],
    queryFn: () => foldersFn({ data: undefined as any }),
  });
  const [scopeFolder, setScopeFolder] = useState<string>("all");
  const [scopeDoc, setScopeDoc] = useState<string>("all");
  const docs = useQuery({
    queryKey: ["documents", scopeFolder === "all" ? null : scopeFolder],
    queryFn: () =>
      docsFn({ data: { folder_id: scopeFolder === "all" ? null : scopeFolder } }),
  });
  const messages = useQuery({
    queryKey: ["copilot-messages"],
    queryFn: () => msgsFn({ data: undefined as any }),
  });

  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.data?.messages.length]);

  const sendMu = useMutation({
    mutationFn: async (q: string) =>
      sendFn({
        data: {
          question: q,
          scope_folder_id: scopeFolder === "all" ? null : scopeFolder,
          scope_document_id: scopeDoc === "all" ? null : scopeDoc,
        },
      }),
    onMutate: (q) => {
      // optimistic user bubble
      qc.setQueryData(["copilot-messages"], (old: any) => ({
        messages: [
          ...(old?.messages ?? []),
          {
            id: `tmp-${Date.now()}`,
            role: "user",
            content: q,
            citations: [],
            scope: {},
            created_at: new Date().toISOString(),
          },
        ],
      }));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["copilot-messages"] }),
  });

  const clearMu = useMutation({
    mutationFn: async () => clearFn({ data: undefined as any }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["copilot-messages"] }),
  });

  // Inline upload
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  async function handleUpload(files: FileList | null) {
    if (!files || !userId) return;
    const f = files[0];
    setUploading(f.name);
    try {
      const ext = f.name.split(".").pop() ?? "bin";
      const folderTarget = scopeFolder === "all" ? null : scopeFolder;
      const path = `${userId}/${folderTarget ?? "copilot"}/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage
        .from("documents")
        .upload(path, f, { contentType: f.type || "application/octet-stream" });
      if (error) throw error;
      await registerFn({
        data: {
          name: f.name,
          mime_type: f.type || "application/octet-stream",
          size_bytes: f.size,
          storage_path: path,
          folder_id: folderTarget,
        },
      });
      qc.invalidateQueries({ queryKey: ["documents"] });
    } catch (e: any) {
      alert(`Upload failed: ${e.message ?? e}`);
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const submit = () => {
    const q = input.trim();
    if (!q || sendMu.isPending) return;
    setInput("");
    sendMu.mutate(q);
  };

  const msgs = messages.data?.messages ?? [];

  return (
    <main className="flex h-[calc(100vh-3.5rem)] flex-col">
      {/* Scope bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card/40 p-3">
        <Sparkles className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">Co-pilot</span>
        <div className="mx-2 h-4 w-px bg-border" />
        <span className="text-xs text-muted-foreground">Search in</span>
        <Select
          value={scopeFolder}
          onValueChange={(v) => {
            setScopeFolder(v);
            setScopeDoc("all");
          }}
        >
          <SelectTrigger className="h-8 w-[180px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All folders</SelectItem>
            {folders.data?.folders.map((f: any) => (
              <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={scopeDoc} onValueChange={setScopeDoc}>
          <SelectTrigger className="h-8 w-[200px] text-xs">
            <SelectValue placeholder="Any document" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any document</SelectItem>
            {docs.data?.documents.map((d: any) => (
              <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => handleUpload(e.target.files)}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileRef.current?.click()}
            disabled={!!uploading}
          >
            {uploading ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="mr-2 h-3.5 w-3.5" />
            )}
            {uploading ? `Processing ${uploading.slice(0, 18)}…` : "Upload"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (confirm("Clear conversation?")) clearMu.mutate();
            }}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" /> Clear
          </Button>
        </div>
      </div>

      {/* Conversation */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-6">
          {msgs.length === 0 && (
            <div className="rounded-xl border border-dashed border-border p-8 text-center">
              <Sparkles className="mx-auto mb-3 h-8 w-8 text-primary/60" />
              <h2 className="text-base font-semibold">Ask your documents anything</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Upload a file or pick a folder, then ask a question. Answers are grounded only in the documents you can access.
              </p>
            </div>
          )}

          {msgs.map((m: any) => (
            <div
              key={m.id}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow-sm ${
                  m.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-card border border-border"
                }`}
              >
                <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-1 prose-ul:my-1">
                  <ReactMarkdown>{m.content}</ReactMarkdown>
                </div>
                {Array.isArray(m.citations) && m.citations.length > 0 && (
                  <div className="mt-3 space-y-1 border-t border-border/50 pt-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
                      Sources
                    </p>
                    {m.citations.map((c: any, i: number) => (
                      <div key={i} className="flex items-start gap-1.5 text-xs opacity-90">
                        <FileText className="mt-0.5 h-3 w-3 shrink-0" />
                        <div className="min-w-0">
                          <span className="font-medium">[{i + 1}]</span>{" "}
                          <span className="truncate">{c.document_name}</span>
                          {c.page_no && (
                            <Badge variant="outline" className="ml-1 h-4 px-1 text-[10px]">
                              p.{c.page_no}
                            </Badge>
                          )}
                          <p className="mt-0.5 line-clamp-2 opacity-70">{c.snippet}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          {sendMu.isPending && (
            <div className="flex justify-start">
              <div className="rounded-2xl border border-border bg-card px-4 py-3 text-sm">
                <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> Thinking…
              </div>
            </div>
          )}
          {sendMu.isError && (
            <p className="text-center text-xs text-destructive">
              {(sendMu.error as Error)?.message ?? "Something went wrong"}
            </p>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-border bg-card/40 p-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <Button
            size="icon"
            variant="ghost"
            className="h-10 w-10 shrink-0"
            onClick={() => fileRef.current?.click()}
            title="Upload a document"
            disabled={!!uploading}
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Paperclip className="h-4 w-4" />
            )}
          </Button>
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Ask anything about your documents… (Enter to send, Shift+Enter for newline)"
            className="min-h-[44px] flex-1 resize-none"
            rows={1}
          />
          <Button onClick={submit} disabled={sendMu.isPending || !input.trim()} className="h-10">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </main>
  );
}

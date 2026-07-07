// One-click status report per project: generate → preview → download PDF →
// pick recipients → send. Delivery status is looked up by the idempotency
// key the server function returns.
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, Loader2, Mail, RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  generateStatusReport,
  listStatusReportRecipients,
  getStatusReportDelivery,
} from "@/lib/agent-briefs.functions";

type Report = {
  html: string;
  brief: string;
  project: { id: string; name: string };
  generated_at: string;
  idempotency_key: string;
};

export function StatusReportDialog({
  projectId,
  projectName,
  open,
  onOpenChange,
}: {
  projectId: string;
  projectName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const genFn = useServerFn(generateStatusReport);
  const listFn = useServerFn(listStatusReportRecipients);
  const deliveryFn = useServerFn(getStatusReportDelivery);

  const [report, setReport] = useState<Report | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Reset on close.
  useEffect(() => {
    if (!open) {
      setReport(null);
      setSelected({});
    }
  }, [open]);

  // Auto-generate the preview on open.
  const generate = useMutation({
    mutationFn: () => genFn({ data: { project_id: projectId } }),
    onSuccess: (res) => {
      if (!("ok" in res) || !res.ok) {
        toast.error("error" in res ? res.error : "Failed to generate report");
        return;
      }
      setReport({
        html: res.html,
        brief: res.brief,
        project: res.project,
        generated_at: res.generated_at,
        idempotency_key: res.idempotency_key,
      });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  useEffect(() => {
    if (open && !report && !generate.isPending) generate.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Recipient picker data.
  const { data: recipData } = useQuery({
    queryKey: ["status-report-recipients", projectId],
    enabled: open,
    queryFn: () => listFn({ data: { project_id: projectId } }),
  });
  const recipients = recipData?.recipients ?? [];

  // Delivery status (polls while the dialog is open and a key exists).
  const { data: delivery, refetch: refetchDelivery } = useQuery({
    queryKey: ["status-report-delivery", report?.idempotency_key],
    enabled: open && !!report?.idempotency_key,
    queryFn: () => deliveryFn({ data: { idempotency_key: report!.idempotency_key } }),
    refetchInterval: 4000,
  });

  const send = useMutation({
    mutationFn: async () => {
      const emails = recipients.filter((r) => selected[r.id]).map((r) => r.email);
      if (emails.length === 0) throw new Error("Pick at least one recipient");
      // Fan-out: enqueue one send per recipient, all sharing the same idem key.
      const results = await Promise.all(
        emails.map((email) =>
          genFn({
            data: {
              project_id: projectId,
              send_email: true,
              recipient_email: email,
            },
          }),
        ),
      );
      return results;
    },
    onSuccess: (results) => {
      const ok = results.filter((r) => "ok" in r && r.ok && r.email?.queued).length;
      toast.success(`Queued ${ok} of ${results.length} email${results.length === 1 ? "" : "s"}`);
      refetchDelivery();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  // Client-side PDF via html2pdf.js (bundled lazily).
  const downloadPdf = async () => {
    if (!report) return;
    try {
      const container = document.createElement("div");
      container.innerHTML = report.html;
      // html2pdf.js has no bundled types; the shape is a chainable builder.
      const mod = (await import("html2pdf.js")) as unknown as {
        default: (element: HTMLElement) => {
          set: (opts: Record<string, unknown>) => {
            from: (el: HTMLElement) => { save: () => Promise<void> };
          };
        };
      };
      await mod
        .default(container)
        .set({
          margin: 12,
          filename: `${report.project.name.replace(/[^a-z0-9-_]+/gi, "_")}-status-${report.generated_at.slice(0, 10)}.pdf`,
          image: { type: "jpeg", quality: 0.95 },
          html2canvas: { scale: 2, useCORS: true },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        })
        .from(container)
        .save();
    } catch (e) {
      toast.error(`PDF failed: ${(e as Error).message}`);
    }
  };

  // Fill preview iframe.
  useEffect(() => {
    if (!report || !iframeRef.current) return;
    const doc = iframeRef.current.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write(report.html);
    doc.close();
  }, [report]);

  const entries = delivery?.entries ?? [];
  const selectedCount = useMemo(
    () => Object.values(selected).filter(Boolean).length,
    [selected],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Status report — {projectName}
            {generate.isPending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_260px]">
          <div className="rounded-md border">
            {report ? (
              <iframe
                ref={iframeRef}
                title="Status report preview"
                className="h-[520px] w-full rounded-md bg-white"
              />
            ) : (
              <div className="flex h-[520px] items-center justify-center text-sm text-muted-foreground">
                {generate.isPending ? "Generating brief…" : "Preview will appear here."}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Send to
                </div>
                <Badge variant="outline" className="text-[10px]">
                  {selectedCount} picked
                </Badge>
              </div>
              <ScrollArea className="h-[220px] rounded-md border p-2">
                {recipients.length === 0 ? (
                  <div className="p-2 text-xs text-muted-foreground">
                    No project members found.
                  </div>
                ) : (
                  recipients.map((r) => (
                    <label
                      key={r.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
                    >
                      <Checkbox
                        checked={!!selected[r.id]}
                        onCheckedChange={(v) =>
                          setSelected((s) => ({ ...s, [r.id]: v === true }))
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{r.name}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {r.email}
                        </div>
                      </div>
                    </label>
                  ))
                )}
              </ScrollArea>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Delivery status
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => refetchDelivery()}
                  aria-label="Refresh delivery status"
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
              </div>
              <div className="max-h-[140px] overflow-auto rounded-md border p-2 text-xs">
                {entries.length === 0 ? (
                  <div className="text-muted-foreground">Nothing sent yet.</div>
                ) : (
                  entries.map((e) => (
                    <div
                      key={e.message_id ?? `${e.recipient}-${e.created_at}`}
                      className="flex items-start justify-between gap-2 border-b py-1 last:border-b-0"
                    >
                      <div className="min-w-0 flex-1 truncate">{e.recipient}</div>
                      <Badge
                        variant={
                          e.status === "sent"
                            ? "default"
                            : e.status === "failed" || e.status === "suppressed"
                              ? "destructive"
                              : "outline"
                        }
                        className="text-[10px]"
                      >
                        {e.status}
                      </Badge>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => generate.mutate()} disabled={generate.isPending}>
            <RefreshCw className="mr-1.5 h-4 w-4" /> Regenerate
          </Button>
          <Button variant="outline" onClick={downloadPdf} disabled={!report}>
            <Download className="mr-1.5 h-4 w-4" /> Download PDF
          </Button>
          <Button
            onClick={() => send.mutate()}
            disabled={!report || send.isPending || selectedCount === 0}
          >
            {send.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-1.5 h-4 w-4" />
            )}
            Send{selectedCount ? ` (${selectedCount})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function StatusReportButton({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Mail className="mr-1.5 h-4 w-4" /> Status report
      </Button>
      {open && (
        <StatusReportDialog
          projectId={projectId}
          projectName={projectName}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}

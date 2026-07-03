import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, Plus, RefreshCw, Trash2, Sheet as SheetIcon, AlertTriangle, ExternalLink, Link2, Shield } from "lucide-react";
import {
  listSheets, inspectSheet, registerAndSyncSheet, refreshSheet, deleteSheet, updateSheetMeta,
} from "@/lib/sheets.functions";
import {
  SHEET_TYPE_LABELS, SHEET_TYPES, CANONICAL_FIELDS, type SheetType,
} from "@/lib/sheets-schemas";
import { useIsAdmin } from "@/hooks/useSession";
import { VisibilityPicker, VisibilityBadge, type Visibility } from "@/components/VisibilityPicker";
import { ChangeVisibilityDialog } from "@/components/ChangeVisibilityDialog";


export const Route = createFileRoute("/_authenticated/sheets")({
  component: SheetsPage,
});

function SheetsPage() {
  const qc = useQueryClient();
  const fetchList = useServerFn(listSheets);
  const removeSheet = useServerFn(deleteSheet);
  const refresh = useServerFn(refreshSheet);

  const sheets = useQuery({ queryKey: ["sheets-list"], queryFn: () => fetchList() });
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<null | { id: string; display_name: string; apps_script_url: string; source_url: string | null }>(null);
  const [visEditing, setVisEditing] = useState<null | { id: string; name: string; visibility: Visibility }>(null);
  const isAdmin = useIsAdmin();


  const refreshMut = useMutation({
    mutationFn: (id: string) => refresh({ data: { registryId: id } }),
    onSuccess: () => {
      toast.success("Sheet refreshed");
      qc.invalidateQueries({ queryKey: ["sheets-list"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Refresh failed"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => removeSheet({ data: { registryId: id } }),
    onSuccess: () => {
      toast.success("Removed");
      qc.invalidateQueries({ queryKey: ["sheets-list"] });
    },
  });

  return (
    <div className="mx-auto w-full max-w-6xl p-4 md:p-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My Sheets</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Register the Apps Script web app URL for each sheet you want the app to read.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> Add API endpoint
          </Button>
        </div>
      </div>

      {sheets.isLoading ? (
        <div className="flex justify-center py-8 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : (sheets.data?.sheets ?? []).length === 0 ? (
        <Card className="p-8 text-center">
          <SheetIcon className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
          <h2 className="text-base font-medium">No sheets yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Click <strong>Add sheet</strong> to register your first one. The AI will read the headers and
            propose how to map them to a canonical schema.
          </p>
        </Card>
      ) : (
        <div className="grid gap-3">
          {sheets.data!.sheets.map((s: any) => (
            <Card key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Link
                    to="/sheets/$sheetId"
                    params={{ sheetId: s.id }}
                    className="truncate font-medium hover:underline"
                  >
                    {s.display_name}
                  </Link>
                  <Badge variant="outline">{SHEET_TYPE_LABELS[s.sheet_type as SheetType]}</Badge>
                  <VisibilityBadge visibility={s.visibility ?? "private"} shareCount={s.share_count} size="xs" />

                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {s.row_count} rows ·{" "}
                  {s.last_refreshed_at
                    ? `refreshed ${new Date(s.last_refreshed_at).toLocaleString()}`
                    : "never refreshed"}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {s.source_url ? (
                  <Button
                    variant="outline"
                    size="sm"
                    asChild
                    title="Open Google Sheet"
                  >
                    <a href={s.source_url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="mr-1.5 h-4 w-4" /> Open sheet
                    </a>
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setEditing({
                      id: s.id,
                      display_name: s.display_name,
                      apps_script_url: s.apps_script_url ?? "",
                      source_url: s.source_url ?? null,
                    })
                  }
                  title="Edit API endpoint & sheet link"
                >
                  <Link2 className="mr-1.5 h-4 w-4" /> Edit link
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refreshMut.mutate(s.id)}
                  disabled={refreshMut.isPending}
                >
                  <RefreshCw className={`mr-1.5 h-4 w-4 ${refreshMut.isPending ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (confirm(`Remove "${s.display_name}"?`)) deleteMut.mutate(s.id);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <AddSheetDialog open={addOpen} onOpenChange={setAddOpen} />
      <EditSheetMetaDialog
        editing={editing}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

function EditSheetMetaDialog({
  editing,
  onClose,
}: {
  editing: null | { id: string; display_name: string; apps_script_url: string; source_url: string | null };
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const update = useServerFn(updateSheetMeta);
  const [apps, setApps] = useState("");
  const [src, setSrc] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    setApps(editing?.apps_script_url ?? "");
    setSrc(editing?.source_url ?? "");
    setName(editing?.display_name ?? "");
  }, [editing]);

  const mut = useMutation({
    mutationFn: () =>
      update({
        data: {
          registryId: editing!.id,
          appsScriptUrl: apps.trim() || undefined,
          sourceUrl: src.trim() === "" ? null : src.trim(),
          displayName: name.trim() || undefined,
        },
      }),
    onSuccess: () => {
      toast.success("Sheet updated");
      qc.invalidateQueries({ queryKey: ["sheets-list"] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Update failed"),
  });

  return (
    <Dialog open={!!editing} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit sheet endpoint & link</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Display name</Label>
            <Input className="mt-1.5" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>API endpoint URL (Apps Script, Emergent, or any JSON API)</Label>
            <Input
              className="mt-1.5 font-mono text-xs"
              value={apps}
              onChange={(e) => setApps(e.target.value)}
              placeholder="https://script.google.com/macros/s/…/exec  •  https://…/api/public/…"
            />
          </div>
          <div>
            <Label>Google Sheet link (for "Open sheet" button)</Label>
            <Input
              className="mt-1.5 font-mono text-xs"
              value={src}
              onChange={(e) => setSrc(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/…"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}




function AddSheetDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const inspect = useServerFn(inspectSheet);
  const register = useServerFn(registerAndSyncSheet);

  const [sheetType, setSheetType] = useState<SheetType>("generic");
  const [appsScriptUrl, setAppsScriptUrl] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [step, setStep] = useState<"input" | "mapping">("input");
  const [inspectResult, setInspectResult] = useState<{
    headers: string[];
    sampleRows: string[][];
    totalRows: number;
    proposedMapping: Record<string, string | null>;
  } | null>(null);

  const resetAll = () => {
    setStep("input");
    setInspectResult(null);
    setAppsScriptUrl("");
    setDisplayName("");
    setSheetType("generic");
  };

  const finishRegister = (res: { id: string }) => {
    toast.success("Sheet imported");
    qc.invalidateQueries({ queryKey: ["sheets-list"] });
    onOpenChange(false);
    resetAll();
    router.navigate({ to: "/sheets/$sheetId", params: { sheetId: res.id } });
  };

  const registerMut = useMutation({
    mutationFn: async (mapping: Record<string, string | null>) => {
      if (!displayName.trim()) throw new Error("Give the sheet a name");
      return register({
        data: {
          appsScriptUrl,
          sheetType,
          displayName: displayName.trim(),
          mapping,
        },
      });
    },
    onSuccess: finishRegister,
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to register"),
  });

  const inspectMut = useMutation({
    mutationFn: () => inspect({ data: { appsScriptUrl, sheetType } }),
    onSuccess: (data) => {
      setInspectResult(data);
      // Generic sheets skip the manual mapping review entirely — auto-import.
      if (sheetType === "generic") {
        registerMut.mutate(data.proposedMapping);
      } else {
        setStep("mapping");
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't read that URL"),
  });

  const saveMappingMut = useMutation({
    mutationFn: async () => {
      if (!inspectResult) throw new Error("Run inspect first");
      return registerMut.mutateAsync(inspectResult.proposedMapping);
    },
  });


  const updateMapping = (header: string, value: string) => {
    if (!inspectResult) return;
    setInspectResult({
      ...inspectResult,
      proposedMapping: {
        ...inspectResult.proposedMapping,
        [header]: value === "__none__" ? null : value,
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) resetAll();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{step === "input" ? "Add a sheet" : "Review column mapping"}</DialogTitle>
        </DialogHeader>

        {step === "input" ? (
          <div className="space-y-4">
            <div>
              <Label>Sheet type</Label>
              <Select value={sheetType} onValueChange={(v) => setSheetType(v as SheetType)}>
                <SelectTrigger className="mt-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SHEET_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {SHEET_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Display name</Label>
              <Input
                className="mt-1.5"
                placeholder="e.g. Site A — Progress"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div>
              <Label>Sheet URL</Label>
              <Input
                className="mt-1.5"
                placeholder="Google Sheets link • Excel/OneDrive link • Apps Script /exec • JSON or CSV URL"
                value={appsScriptUrl}
                onChange={(e) => setAppsScriptUrl(e.target.value)}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Paste a Google Sheets share link, an Excel/OneDrive share link, or any
                HTTPS endpoint returning JSON (<code>{`{ headers, rows }`}</code> or an
                array of objects) or CSV.
              </p>
              <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  The sheet must be viewable by <strong>Anyone with the link</strong>.
                  Don't paste links to data you wouldn't share publicly.
                </span>
              </div>
            </div>
          </div>
        ) : inspectResult ? (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
              <div className="font-medium">{displayName || "Untitled"}</div>
              <div className="text-xs text-muted-foreground">
                {inspectResult.headers.length} columns · {inspectResult.totalRows} rows detected
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              AI suggested these mappings. Adjust any that look wrong, then save.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="pb-2">Source header</th>
                    <th className="pb-2">Canonical field</th>
                  </tr>
                </thead>
                <tbody>
                  {inspectResult.headers.map((h) => (
                    <tr key={h} className="border-t border-border">
                      <td className="py-2 pr-3 font-mono text-xs">{h}</td>
                      <td className="py-2">
                        <Select
                          value={inspectResult.proposedMapping[h] ?? "__none__"}
                          onValueChange={(v) => updateMapping(h, v)}
                        >
                          <SelectTrigger className="h-8 w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">— ignore (keep as extra) —</SelectItem>
                            {CANONICAL_FIELDS[sheetType].map((f) => (
                              <SelectItem key={f} value={f}>
                                {f}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          {step === "input" ? (
            <Button
              onClick={() => inspectMut.mutate()}
              disabled={
                inspectMut.isPending || registerMut.isPending || !appsScriptUrl || !displayName
              }
            >
              {(inspectMut.isPending || registerMut.isPending) && (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              )}
              {sheetType === "generic" ? "Import sheet" : "Inspect with AI"}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setStep("input")}>
                Back
              </Button>
              <Button
                onClick={() => saveMappingMut.mutate()}
                disabled={registerMut.isPending || saveMappingMut.isPending}
              >
                {(registerMut.isPending || saveMappingMut.isPending) && (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                )}
                Save & sync
              </Button>
            </>
          )}

        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

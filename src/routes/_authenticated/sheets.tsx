import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, Plus, RefreshCw, Trash2, Link2, Unlink, Sheet as SheetIcon } from "lucide-react";
import {
  startGoogleConnect, getGoogleConnection, saveGoogleConnection, disconnectGoogle,
  listSheets, inspectSheet, registerAndSyncSheet, refreshSheet, deleteSheet,
} from "@/lib/sheets.functions";
import { connectAppUser } from "@/integrations/lovable/appUserConnectorClient";
import {
  SHEET_TYPE_LABELS, SHEET_TYPES, CANONICAL_FIELDS, extractSheetId, type SheetType,
} from "@/lib/sheets-schemas";

const GATEWAY_BASE_URL = "https://connector-gateway.lovable.dev";

export const Route = createFileRoute("/_authenticated/sheets")({
  component: SheetsPage,
});

function SheetsPage() {
  const qc = useQueryClient();
  const fetchConn = useServerFn(getGoogleConnection);
  const fetchList = useServerFn(listSheets);
  const startConn = useServerFn(startGoogleConnect);
  const saveConn = useServerFn(saveGoogleConnection);
  const disconnect = useServerFn(disconnectGoogle);
  const removeSheet = useServerFn(deleteSheet);
  const refresh = useServerFn(refreshSheet);

  const conn = useQuery({ queryKey: ["google-conn"], queryFn: () => fetchConn() });
  const sheets = useQuery({
    queryKey: ["sheets-list"],
    queryFn: () => fetchList(),
    enabled: !!conn.data?.connected,
  });

  const [addOpen, setAddOpen] = useState(false);

  const connectMut = useMutation({
    mutationFn: async () => {
      const result = await connectAppUser({
        connectorId: "google",
        gatewayBaseUrl: GATEWAY_BASE_URL,
        start: (targetOrigin) => startConn({ data: { targetOrigin } }),
      });
      if (!result.success || !result.connectionId) {
        throw new Error(result.error ?? "OAuth failed");
      }
      await saveConn({ data: { connectionId: result.connectionId } });
    },
    onSuccess: () => {
      toast.success("Google account connected");
      qc.invalidateQueries({ queryKey: ["google-conn"] });
      qc.invalidateQueries({ queryKey: ["sheets-list"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to connect"),
  });

  const disconnectMut = useMutation({
    mutationFn: () => disconnect({}),
    onSuccess: () => {
      toast.success("Disconnected");
      qc.invalidateQueries({ queryKey: ["google-conn"] });
    },
  });

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
            Connect your Google account and register the sheets you want the app to read.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {conn.data?.connected ? (
            <>
              <Badge variant="secondary" className="gap-1">
                <Link2 className="h-3 w-3" />
                {conn.data.googleEmail ?? "Google connected"}
              </Badge>
              <Button variant="outline" size="sm" onClick={() => disconnectMut.mutate()}>
                <Unlink className="mr-1.5 h-4 w-4" /> Disconnect
              </Button>
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" /> Add sheet
              </Button>
            </>
          ) : (
            <Button onClick={() => connectMut.mutate()} disabled={connectMut.isPending}>
              {connectMut.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Link2 className="mr-1.5 h-4 w-4" />
              )}
              Connect Google
            </Button>
          )}
        </div>
      </div>

      {!conn.data?.connected ? (
        <Card className="p-8 text-center">
          <SheetIcon className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
          <h2 className="text-base font-medium">Connect your Google account</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Sign in with the Google account that owns your project sheets. The app will get read-only access
            to the sheets you register here — nothing else.
          </p>
        </Card>
      ) : sheets.isLoading ? (
        <div className="flex justify-center py-8 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : (sheets.data?.sheets ?? []).length === 0 ? (
        <Card className="p-8 text-center">
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
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {s.row_count} rows · tab “{s.tab_name}” ·{" "}
                  {s.last_refreshed_at
                    ? `refreshed ${new Date(s.last_refreshed_at).toLocaleString()}`
                    : "never refreshed"}
                </div>
              </div>
              <div className="flex items-center gap-2">
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
                    if (confirm(`Remove “${s.display_name}”?`)) deleteMut.mutate(s.id);
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
    </div>
  );
}

function AddSheetDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const inspect = useServerFn(inspectSheet);
  const register = useServerFn(registerAndSyncSheet);

  const [sheetType, setSheetType] = useState<SheetType>("progress");
  const [urlOrId, setUrlOrId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [step, setStep] = useState<"input" | "mapping">("input");
  const [inspectResult, setInspectResult] = useState<{
    spreadsheetTitle: string;
    tabName: string;
    headers: string[];
    sampleRows: string[][];
    proposedMapping: Record<string, string | null>;
  } | null>(null);

  const resetAll = () => {
    setStep("input");
    setInspectResult(null);
    setUrlOrId("");
    setDisplayName("");
    setSheetType("progress");
  };

  const inspectMut = useMutation({
    mutationFn: async () => {
      const id = extractSheetId(urlOrId);
      if (!id) throw new Error("That doesn't look like a Google Sheet URL or ID.");
      return inspect({ data: { googleSheetId: id, sheetType } });
    },
    onSuccess: (data) => {
      setInspectResult(data);
      if (!displayName) setDisplayName(data.spreadsheetTitle);
      setStep("mapping");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't read that sheet"),
  });

  const registerMut = useMutation({
    mutationFn: async () => {
      if (!inspectResult) throw new Error("Run inspect first");
      const id = extractSheetId(urlOrId)!;
      return register({
        data: {
          googleSheetId: id,
          sheetType,
          tabName: inspectResult.tabName,
          displayName: displayName || inspectResult.spreadsheetTitle,
          mapping: inspectResult.proposedMapping,
        },
      });
    },
    onSuccess: (res) => {
      toast.success("Sheet registered");
      qc.invalidateQueries({ queryKey: ["sheets-list"] });
      onOpenChange(false);
      resetAll();
      router.navigate({ to: "/sheets/$sheetId", params: { sheetId: res.id } });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to register"),
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
              <Label>Google Sheet URL or ID</Label>
              <Input
                className="mt-1.5"
                placeholder="https://docs.google.com/spreadsheets/d/…"
                value={urlOrId}
                onChange={(e) => setUrlOrId(e.target.value)}
              />
            </div>
            <div>
              <Label>Display name (optional)</Label>
              <Input
                className="mt-1.5"
                placeholder="e.g. Site A — Progress"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
          </div>
        ) : inspectResult ? (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
              <div className="font-medium">{inspectResult.spreadsheetTitle}</div>
              <div className="text-xs text-muted-foreground">Tab: {inspectResult.tabName}</div>
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
            <Button onClick={() => inspectMut.mutate()} disabled={inspectMut.isPending || !urlOrId}>
              {inspectMut.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Inspect with AI
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setStep("input")}>
                Back
              </Button>
              <Button onClick={() => registerMut.mutate()} disabled={registerMut.isPending}>
                {registerMut.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                Save & sync
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

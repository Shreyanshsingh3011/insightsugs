import { createFileRoute, useRouter, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Loader2, Upload, ClipboardPaste, Link2, FileSpreadsheet, ArrowLeft, CheckCircle2, AlertTriangle,
} from "lucide-react";
import {
  SHEET_TYPE_LABELS, SHEET_TYPES, CANONICAL_FIELDS, type SheetType,
} from "@/lib/sheets-schemas";
import { proposeUploadMapping, ingestParsedTable } from "@/lib/ingest.functions";
import {
  inspectSheet, registerAndSyncSheet,
} from "@/lib/sheets.functions";
import { useIsAdmin } from "@/hooks/useSession";
import { VisibilityPicker, type Visibility } from "@/components/VisibilityPicker";

export const Route = createFileRoute("/_authenticated/ingest")({
  head: () => ({
    meta: [
      { title: "Ingest data — Insights" },
      { name: "description", content: "Upload CSV/XLSX, paste tabular data, or connect a URL. Preview, map columns, and load in seconds." },
    ],
  }),
  component: IngestPage,
});

type Parsed = { headers: string[]; rows: string[][]; source: "csv" | "xlsx" | "paste" };

function IngestPage() {
  return (
    <div className="mx-auto w-full max-w-5xl p-4 md:p-6">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
            <Link to="/sheets" className="inline-flex items-center gap-1 hover:underline">
              <ArrowLeft className="h-3 w-3" /> Back to datasets
            </Link>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Ingest data</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Drop a CSV/Excel file, paste rows from your clipboard, or connect a URL. Preview first, then load.
          </p>
        </div>
      </div>

      <Tabs defaultValue="upload" className="w-full">
        <TabsList className="grid w-full max-w-md grid-cols-3">
          <TabsTrigger value="upload"><Upload className="mr-1.5 h-4 w-4" />File</TabsTrigger>
          <TabsTrigger value="paste"><ClipboardPaste className="mr-1.5 h-4 w-4" />Paste</TabsTrigger>
          <TabsTrigger value="url"><Link2 className="mr-1.5 h-4 w-4" />URL</TabsTrigger>
        </TabsList>

        <TabsContent value="upload" className="mt-4">
          <FileTab />
        </TabsContent>
        <TabsContent value="paste" className="mt-4">
          <PasteTab />
        </TabsContent>
        <TabsContent value="url" className="mt-4">
          <UrlTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ---------- File tab ---------- */

function FileTab() {
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);
  const [parsing, setParsing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setParsing(true);
    setFileName(file.name);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase();
      if (ext === "csv" || ext === "tsv" || ext === "txt") {
        const Papa = (await import("papaparse")).default;
        const text = await file.text();
        const result = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
        const rows = (result.data as string[][]).filter((r) => r.length > 0);
        if (rows.length === 0) throw new Error("File is empty");
        const [headers, ...body] = rows;
        setParsed({
          headers: headers.map((h) => String(h ?? "").trim()),
          rows: body.map((r) => headers.map((_, i) => String(r[i] ?? ""))),
          source: "csv",
        });
      } else if (ext === "xlsx" || ext === "xls") {
        const XLSX = await import("xlsx");
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "", raw: false });
        if (rows.length === 0) throw new Error("Sheet is empty");
        const [headers, ...body] = rows;
        setParsed({
          headers: headers.map((h) => String(h ?? "").trim()),
          rows: body.map((r) => headers.map((_, i) => String(r[i] ?? ""))),
          source: "xlsx",
        });
      } else {
        throw new Error("Unsupported file type. Use CSV, TSV, or XLSX.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't parse file");
    } finally {
      setParsing(false);
    }
  }, []);

  return (
    <Card
      className={`p-6 ${dragOver ? "border-primary/60 bg-primary/5" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) handleFile(f);
      }}
    >
      {!parsed ? (
        <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
          <FileSpreadsheet className="h-10 w-10 text-muted-foreground" />
          <div>
            <div className="font-medium">Drop a CSV or Excel file here</div>
            <div className="text-xs text-muted-foreground">or click to choose. First row must be headers.</div>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.xls"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          />
          <Button size="sm" onClick={() => fileInput.current?.click()} disabled={parsing}>
            {parsing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Upload className="mr-1.5 h-4 w-4" />}
            Choose file
          </Button>
          {fileName && <div className="text-xs text-muted-foreground">Last: {fileName}</div>}
        </div>
      ) : (
        <PreviewAndCommit
          parsed={parsed}
          onReset={() => setParsed(null)}
          defaultName={fileName.replace(/\.[^.]+$/, "")}
        />
      )}
    </Card>
  );
}

/* ---------- Paste tab ---------- */

function PasteTab() {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<Parsed | null>(null);

  const parsePasted = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed) { toast.error("Paste some data first"); return; }
    try {
      const Papa = (await import("papaparse")).default;
      // Auto-detect delimiter (tab from Excel/Sheets, comma from CSV).
      const result = Papa.parse<string[]>(trimmed, { skipEmptyLines: "greedy" });
      const rows = (result.data as string[][]).filter((r) => r.length > 0);
      if (rows.length < 2) throw new Error("Need at least a header row and one data row");
      const [headers, ...body] = rows;
      setParsed({
        headers: headers.map((h) => String(h ?? "").trim()),
        rows: body.map((r) => headers.map((_, i) => String(r[i] ?? ""))),
        source: "paste",
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't parse");
    }
  }, [text]);

  return (
    <Card className="p-4">
      {!parsed ? (
        <div className="space-y-3">
          <Label>Paste rows (from Excel, Sheets, or CSV — first row = headers)</Label>
          <Textarea
            rows={12}
            className="font-mono text-xs"
            placeholder={"activity\towner\tstatus\nFoundation\tRaj\tin_progress\nColumns\tMeera\tdelayed"}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex justify-end">
            <Button size="sm" onClick={parsePasted} disabled={!text.trim()}>
              Preview
            </Button>
          </div>
        </div>
      ) : (
        <PreviewAndCommit
          parsed={parsed}
          onReset={() => setParsed(null)}
          defaultName=""
        />
      )}
    </Card>
  );
}

/* ---------- URL tab ---------- */

function UrlTab() {
  const qc = useQueryClient();
  const router = useRouter();
  const isAdmin = useIsAdmin();
  const inspect = useServerFn(inspectSheet);
  const register = useServerFn(registerAndSyncSheet);

  const [url, setUrl] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [sheetType, setSheetType] = useState<SheetType>("generic");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [sharedIds, setSharedIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<null | { headers: string[]; sampleRows: string[][]; totalRows: number; proposedMapping: Record<string, string | null> }>(null);

  const inspectMut = useMutation({
    mutationFn: () => inspect({ data: { appsScriptUrl: url, sheetType } }),
    onSuccess: (data) => setPreview(data),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't read that URL"),
  });

  const registerMut = useMutation({
    mutationFn: () => {
      if (!displayName.trim()) throw new Error("Give it a name");
      if (!preview) throw new Error("Preview first");
      return register({ data: {
        appsScriptUrl: url, sheetType,
        displayName: displayName.trim(),
        mapping: preview.proposedMapping,
        visibility: isAdmin ? visibility : "private",
        sharedUserIds: isAdmin && visibility === "shared" ? sharedIds : [],
      }});
    },
    onSuccess: (res) => {
      toast.success("Dataset connected");
      qc.invalidateQueries({ queryKey: ["sheets-list"] });
      router.navigate({ to: "/sheets/$sheetId", params: { sheetId: res.id } });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to register"),
  });

  return (
    <Card className="space-y-4 p-4">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <Label>Display name</Label>
          <Input className="mt-1.5" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Site A — Progress" />
        </div>
        <div>
          <Label>Type</Label>
          <Select value={sheetType} onValueChange={(v) => setSheetType(v as SheetType)}>
            <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
            <SelectContent>
              {SHEET_TYPES.map((t) => <SelectItem key={t} value={t}>{SHEET_TYPE_LABELS[t]}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label>Data URL</Label>
        <Input
          className="mt-1.5 font-mono text-xs"
          placeholder="Google Sheets link • Apps Script /exec • JSON or CSV URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Sheet must be viewable by <strong>Anyone with the link</strong>.</span>
        </div>
      </div>
      {isAdmin && (
        <div className="rounded-md border p-3">
          <VisibilityPicker
            visibility={visibility}
            onVisibilityChange={setVisibility}
            sharedUserIds={sharedIds}
            onSharedUserIdsChange={setSharedIds}
          />
        </div>
      )}

      {!preview ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => inspectMut.mutate()} disabled={!url.trim() || inspectMut.isPending}>
            {inspectMut.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Preview
          </Button>
        </div>
      ) : (
        <>
          <PreviewTable headers={preview.headers} rows={preview.sampleRows} totalRows={preview.totalRows} mapping={preview.proposedMapping} sheetType={sheetType} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>Change URL</Button>
            <Button size="sm" onClick={() => registerMut.mutate()} disabled={registerMut.isPending || !displayName.trim()}>
              {registerMut.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Connect &amp; load
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

/* ---------- Shared preview + commit for File / Paste ---------- */

function PreviewAndCommit({
  parsed, onReset, defaultName,
}: { parsed: Parsed; onReset: () => void; defaultName: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  const isAdmin = useIsAdmin();
  const propose = useServerFn(proposeUploadMapping);
  const ingest = useServerFn(ingestParsedTable);

  const [displayName, setDisplayName] = useState(defaultName || "");
  const [sheetType, setSheetType] = useState<SheetType>("generic");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [sharedIds, setSharedIds] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string | null>>(() => {
    const empty: Record<string, string | null> = {};
    for (const h of parsed.headers) empty[h] = null;
    return empty;
  });
  const [mappingLoading, setMappingLoading] = useState(false);

  const refreshMapping = useCallback(async (type: SheetType) => {
    setMappingLoading(true);
    try {
      const res = await propose({ data: { sheetType: type, headers: parsed.headers } });
      setMapping(res.proposedMapping);
    } finally {
      setMappingLoading(false);
    }
  }, [propose, parsed.headers]);

  const canonical = CANONICAL_FIELDS[sheetType];

  const ingestMut = useMutation({
    mutationFn: () => {
      if (!displayName.trim()) throw new Error("Give it a name");
      return ingest({ data: {
        sheetType, displayName: displayName.trim(),
        headers: parsed.headers, rows: parsed.rows,
        mapping,
        visibility: isAdmin ? visibility : "private",
        sharedUserIds: isAdmin && visibility === "shared" ? sharedIds : [],
        sourceLabel: parsed.source,
      }});
    },
    onSuccess: (res) => {
      toast.success(`Loaded ${res.rowCount.toLocaleString()} rows`);
      qc.invalidateQueries({ queryKey: ["sheets-list"] });
      router.navigate({ to: "/sheets/$sheetId", params: { sheetId: res.id } });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to load"),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          <span className="font-medium">{parsed.rows.length.toLocaleString()} rows</span>
          <Badge variant="outline">{parsed.headers.length} columns</Badge>
          <Badge variant="outline" className="uppercase">{parsed.source}</Badge>
        </div>
        <Button variant="ghost" size="sm" onClick={onReset}>Choose another</Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <Label>Display name</Label>
          <Input className="mt-1.5" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Site A — Progress" />
        </div>
        <div>
          <Label>Type (drives column mapping)</Label>
          <Select
            value={sheetType}
            onValueChange={(v) => { setSheetType(v as SheetType); refreshMapping(v as SheetType); }}
          >
            <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
            <SelectContent>
              {SHEET_TYPES.map((t) => <SelectItem key={t} value={t}>{SHEET_TYPE_LABELS[t]}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isAdmin && (
        <div className="rounded-md border p-3">
          <VisibilityPicker
            visibility={visibility}
            onVisibilityChange={setVisibility}
            sharedUserIds={sharedIds}
            onSharedUserIdsChange={setSharedIds}
          />
        </div>
      )}

      <PreviewTable
        headers={parsed.headers}
        rows={parsed.rows.slice(0, 5)}
        totalRows={parsed.rows.length}
        mapping={mapping}
        onMappingChange={canonical.length > 0 ? (h, v) => setMapping((m) => ({ ...m, [h]: v })) : undefined}
        sheetType={sheetType}
        mappingLoading={mappingLoading}
      />

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onReset}>Cancel</Button>
        <Button size="sm" onClick={() => ingestMut.mutate()} disabled={ingestMut.isPending || !displayName.trim()}>
          {ingestMut.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          Load {parsed.rows.length.toLocaleString()} rows
        </Button>
      </div>
    </div>
  );
}

/* ---------- Preview table ---------- */

function PreviewTable({
  headers, rows, totalRows, mapping, onMappingChange, sheetType, mappingLoading,
}: {
  headers: string[];
  rows: string[][];
  totalRows: number;
  mapping: Record<string, string | null>;
  onMappingChange?: (header: string, value: string | null) => void;
  sheetType: SheetType;
  mappingLoading?: boolean;
}) {
  const canonical = useMemo(() => CANONICAL_FIELDS[sheetType], [sheetType]);
  const hasCanonical = canonical.length > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          Showing {rows.length} of {totalRows.toLocaleString()} rows
          {mappingLoading && <span className="ml-2"><Loader2 className="inline h-3 w-3 animate-spin" /> mapping…</span>}
        </div>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-left">
            <tr>
              {headers.map((h, i) => (
                <th key={i} className="min-w-[140px] border-b p-2 align-top">
                  <div className="font-medium">{h || <span className="text-muted-foreground">col {i + 1}</span>}</div>
                  {hasCanonical && (
                    <div className="mt-1">
                      {onMappingChange ? (
                        <Select
                          value={mapping[h] ?? "__none__"}
                          onValueChange={(v) => onMappingChange(h, v === "__none__" ? null : v)}
                        >
                          <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">— extra —</SelectItem>
                            {canonical.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">
                          {mapping[h] ?? "extra"}
                        </Badge>
                      )}
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className="border-b last:border-0">
                {headers.map((_, ci) => (
                  <td key={ci} className="p-2 align-top text-muted-foreground">{r[ci] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

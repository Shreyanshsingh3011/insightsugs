import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  listMyBriefings,
  getBriefing,
  getMyBriefingPreferences,
  saveMyBriefingPreferences,
  generateBriefingsNow,
} from "@/lib/briefings.functions";
import { exportBriefingMarkdown, exportBriefingPdf } from "@/lib/briefing-export";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Settings2, Loader2, Download, FileText } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/briefings")({
  head: () => ({
    meta: [
      { title: "Weekly Briefing Reports — DelayLens" },
      {
        name: "description",
        content: "Generate, view, and download weekly operations briefing reports.",
      },
      { property: "og:title", content: "Weekly Briefing Reports — DelayLens" },
      {
        property: "og:description",
        content: "Generate, view, and download weekly operations briefing reports.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BriefingsPage,
});

const SECTION_OPTIONS = [
  { id: "projects", label: "Projects & activities" },
  { id: "sheets", label: "Sheets" },
  { id: "documents", label: "Documents" },
  { id: "alerts", label: "Alerts & concerns" },
] as const;

const PRIORITY_OPTIONS = [
  { id: "top", label: "Overdue first (surfaced at the top)" },
  { id: "by_due_date", label: "By due date (earliest first)" },
  { id: "by_age", label: "By age (least recently updated first)" },
] as const;

function BriefingsPage() {
  const listFn = useServerFn(listMyBriefings);
  const getFn = useServerFn(getBriefing);
  const getPrefsFn = useServerFn(getMyBriefingPreferences);
  const savePrefsFn = useServerFn(saveMyBriefingPreferences);
  const genNowFn = useServerFn(generateBriefingsNow);
  const qc = useQueryClient();

  const { data: list } = useQuery({ queryKey: ["briefings"], queryFn: () => listFn() });
  const { data: prefs } = useQuery({ queryKey: ["briefing-prefs"], queryFn: () => getPrefsFn() });

  const [selected, setSelected] = useState<string | null>(null);
  const [showPrefs, setShowPrefs] = useState(false);
  const [sections, setSections] = useState<string[]>([]);
  const [priority, setPriority] = useState<string>("top");

  useEffect(() => {
    if (prefs) {
      setSections(prefs.sections);
      setPriority(prefs.overdue_priority);
    }
  }, [prefs]);

  const save = useMutation({
    mutationFn: () =>
      savePrefsFn({ data: { sections: sections as any, overdue_priority: priority as any } }),
    onSuccess: () => {
      toast.success("Preferences saved. They apply on the next Monday briefing.");
      qc.invalidateQueries({ queryKey: ["briefing-prefs"] });
      setShowPrefs(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const generate = useMutation({
    mutationFn: () => genNowFn(),
    onSuccess: (r: any) => {
      toast.success(`Briefing generated for ${r?.users_briefed ?? 0} user(s).`);
      qc.invalidateQueries({ queryKey: ["briefings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });


  const { data: current, isLoading } = useQuery({
    queryKey: ["briefing", selected],
    queryFn: () => (selected ? getFn({ data: { id: selected } }) : null),
    enabled: !!selected,
  });

  const toggleSection = (id: string) =>
    setSections((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Weekly briefings</h1>
          <p className="text-sm text-muted-foreground">AI-generated summaries of what happened across your projects, activities, sheets, documents, and alerts.</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
          >
            {generate.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Generate now
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowPrefs((v) => !v)}>
            <Settings2 className="mr-1.5 h-4 w-4" /> Customize
          </Button>
        </div>

      </div>

      {showPrefs && (
        <Card className="mb-4 p-5">
          <h2 className="text-sm font-medium">Your briefing preferences</h2>
          <p className="mt-1 text-xs text-muted-foreground">Choose which sections appear and how overdue items are prioritized.</p>

          <div className="mt-4 grid gap-6 md:grid-cols-2">
            <div>
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Sections</Label>
              <div className="mt-2 space-y-2">
                {SECTION_OPTIONS.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={sections.includes(s.id)}
                      onCheckedChange={() => toggleSection(s.id)}
                    />
                    <span>{s.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Overdue priority</Label>
              <RadioGroup value={priority} onValueChange={setPriority} className="mt-2 space-y-2">
                {PRIORITY_OPTIONS.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value={p.id} id={`prio-${p.id}`} />
                    <span>{p.label}</span>
                  </label>
                ))}
              </RadioGroup>
            </div>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowPrefs(false)}>Cancel</Button>
            <Button
              size="sm"
              onClick={() => save.mutate()}
              disabled={save.isPending || sections.length === 0}
            >
              {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save preferences"}
            </Button>
          </div>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-[280px_1fr]">
        <div className="space-y-2">
          {(list ?? []).length === 0 && (
            <Card className="p-4 text-sm text-muted-foreground">
              No briefings yet. They generate every Monday at 08:00 UTC.
            </Card>
          )}
          {(list ?? []).map((b) => (
            <button
              key={b.id}
              onClick={() => setSelected(b.id)}
              className={`w-full rounded-md border p-3 text-left transition hover:bg-accent ${selected === b.id ? "border-primary bg-accent" : "border-border"}`}
            >
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{b.week_start} → {b.week_end}</span>
                <Badge variant={b.scope === "org" ? "default" : "secondary"}>{b.scope === "org" ? "Org" : "You"}</Badge>
              </div>
              <div className="mt-1 text-sm font-medium">
                {b.scope === "org" ? "Org-wide briefing" : "Your briefing"}
              </div>
            </button>
          ))}
        </div>

        <Card className="p-6">
          {!selected && (
            <div className="text-sm text-muted-foreground">Select a briefing on the left to read it.</div>
          )}
          {selected && isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
          {selected && current && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
                <div>
                  <div className="text-sm font-medium">
                    {current.scope === "org" ? "Org-wide report" : "Your report"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {current.week_start} → {current.week_end}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => exportBriefingMarkdown(current)}
                  >
                    <FileText className="h-4 w-4" />
                    Markdown
                  </Button>
                  <Button size="sm" onClick={() => exportBriefingPdf(current)}>
                    <Download className="h-4 w-4" />
                    PDF report
                  </Button>
                </div>
              </div>
              <article className="prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown>{current.content_markdown}</ReactMarkdown>
              </article>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

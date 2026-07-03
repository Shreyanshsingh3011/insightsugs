import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { listMyBriefings, getBriefing } from "@/lib/briefings.functions";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/briefings")({
  component: BriefingsPage,
});

function BriefingsPage() {
  const listFn = useServerFn(listMyBriefings);
  const getFn = useServerFn(getBriefing);
  const { data: list } = useQuery({ queryKey: ["briefings"], queryFn: () => listFn() });
  const [selected, setSelected] = useState<string | null>(null);

  const { data: current, isLoading } = useQuery({
    queryKey: ["briefing", selected],
    queryFn: () => (selected ? getFn({ data: { id: selected } }) : null),
    enabled: !!selected,
  });

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Weekly briefings</h1>
        <p className="text-sm text-muted-foreground">AI-generated summaries of what happened across your projects, activities, sheets, documents, and alerts.</p>
      </div>

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
            <article className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown>{current.content_markdown}</ReactMarkdown>
            </article>
          )}
        </Card>
      </div>
    </div>
  );
}

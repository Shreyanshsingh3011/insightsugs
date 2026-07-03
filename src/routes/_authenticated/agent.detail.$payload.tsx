// Legacy aggregate detail page. Every dashboard sink now routes directly to a
// dedicated detail page (/agent/row/$key, /agent/kpi/$id, /agent/person/$key,
// /agent/stage/$key, /agent/project/$projectId). We keep this URL alive as a
// permanent redirect so any bookmarked link from the previous scheme still
// lands on something meaningful.

import { useEffect, useMemo } from "react";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { Loader2, ArrowLeft } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { decodeDetailPayload, type DetailPayload } from "@/lib/agent-detail-payload";
import { encodeRowKey, encodeKey as encodeEntityKey } from "@/lib/entity-scope";

export const Route = createFileRoute("/_authenticated/agent/detail/$payload")({
  head: () => ({ meta: [{ title: "Redirecting… — DelayLens" }] }),
  component: RedirectPage,
});

function RedirectPage() {
  const { payload: encoded } = Route.useParams();
  const nav = useNavigate();

  const data = useMemo<DetailPayload | null>(() => {
    try { return decodeDetailPayload(encoded); } catch { return null; }
  }, [encoded]);

  useEffect(() => {
    if (!data) {
      nav({ to: "/agent/kpi/$id", params: { id: "health" }, replace: true });
      return;
    }
    // Prefer the row page when the legacy payload carried a source row.
    if (data.row) {
      const row = data.row as Record<string, unknown>;
      const key = encodeRowKey({
        project: String(data.projectLabel ?? row["__project"] ?? ""),
        srNo: String(row["Sr. No."] ?? row["Sr No"] ?? row["ID"] ?? ""),
        activity: String(row["Activity List"] ?? row["Process Descriptions"] ?? row["Process"] ?? data.title ?? ""),
      });
      nav({ to: "/agent/row/$key", params: { key }, replace: true });
      return;
    }
    if (data.person) {
      nav({ to: "/agent/person/$key", params: { key: encodeEntityKey(data.person) }, replace: true });
      return;
    }
    if (data.stage) {
      nav({ to: "/agent/stage/$key", params: { key: encodeEntityKey(data.stage) }, replace: true });
      return;
    }
    if (data.projectId) {
      nav({ to: "/agent/project/$projectId", params: { projectId: data.projectId }, replace: true });
      return;
    }
    nav({ to: "/agent/kpi/$id", params: { id: "health" }, replace: true });
  }, [data, nav]);

  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <Link to="/agent" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Back to dashboard
      </Link>
      <Card className="mt-4">
        <CardContent className="flex items-center gap-3 p-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <div>
            <div className="text-sm font-medium">Redirecting to the new detail page…</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              This aggregate URL has been replaced with dedicated per-entity pages.
            </div>
          </div>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => nav({ to: "/agent" })}>
            Dashboard
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

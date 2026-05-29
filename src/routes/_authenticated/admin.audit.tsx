import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useIsAdmin } from "@/hooks/useSession";
import { Card } from "@/components/ui/card";

export const Route = createFileRoute("/_authenticated/admin/audit")({
  head: () => ({ meta: [{ title: "Audit Log — DelayLens" }] }),
  component: AuditPage,
});

type Entry = {
  id: string;
  actor_id: string | null;
  project_id: string | null;
  activity_id: string | null;
  event_type: string;
  details: Record<string, unknown>;
  created_at: string;
};

function AuditPage() {
  const isAdmin = useIsAdmin();
  const { data } = useQuery({
    queryKey: ["audit_log"],
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("audit_log").select("*").order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return data as Entry[];
    },
  });

  if (!isAdmin) return <div className="mx-auto max-w-5xl px-4 py-8 text-muted-foreground">Admins only.</div>;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Audit Log</h1>
      <Card className="mt-6 divide-y divide-border/60">
        {data?.length === 0 && <p className="p-6 text-sm text-muted-foreground">No events yet.</p>}
        {data?.map((e) => (
          <div key={e.id} className="grid grid-cols-[160px_1fr] gap-4 p-3 text-sm">
            <div className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleString()}</div>
            <div>
              <span className="font-medium">{e.event_type}</span>
              <pre className="mt-1 overflow-x-auto rounded bg-muted/40 p-2 text-xs">{JSON.stringify(e.details, null, 2)}</pre>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/hooks/useSession";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCheck } from "lucide-react";

export const Route = createFileRoute("/_authenticated/notifications")({
  head: () => ({ meta: [{ title: "Notifications — DelayLens" }] }),
  component: NotificationsPage,
});

type N = { id: string; kind: string; title: string; body: string | null; created_at: string; read_at: string | null };

function NotificationsPage() {
  const { userId } = useSession();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["notifications", userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notifications").select("*").eq("user_id", userId!).order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      return data as N[];
    },
  });

  const markAll = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("user_id", userId!).is("read_at", null);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
        <Button variant="outline" size="sm" onClick={() => markAll.mutate()}>
          <CheckCheck className="mr-1.5 h-4 w-4" /> Mark all read
        </Button>
      </div>
      <Card className="mt-6 divide-y divide-border/60">
        {data?.length === 0 && <p className="p-8 text-center text-sm text-muted-foreground">You're all caught up.</p>}
        {data?.map((n) => (
          <div key={n.id} className={`p-4 ${n.read_at ? "opacity-60" : ""}`}>
            <div className="flex items-center gap-2">
              <Badge variant={n.read_at ? "outline" : "default"}>{n.kind}</Badge>
              <span className="font-medium">{n.title}</span>
              <span className="ml-auto text-xs text-muted-foreground">{new Date(n.created_at).toLocaleString()}</span>
            </div>
            {n.body && <p className="mt-1 text-sm text-muted-foreground">{n.body}</p>}
          </div>
        ))}
      </Card>
    </div>
  );
}

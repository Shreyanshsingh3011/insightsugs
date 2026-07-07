import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, RefreshCw, Plug, Settings2 } from "lucide-react";
import { getActiveIntegrationStatus } from "@/lib/integrations.functions";
import { useIsSuper } from "@/hooks/useSession";

export function ActiveIntegrationCard() {
  const isSuper = useIsSuper();
  const fn = useServerFn(getActiveIntegrationStatus);
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["active-integration-status"],
    queryFn: () => fn(),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  return (
    <Card className="border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Plug className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Live integration</h2>
            {data?.configured && data.status && (
              <Badge
                variant={data.status.ok ? "default" : "destructive"}
                className="gap-1 text-[10px]"
              >
                <Activity className="h-3 w-3" />
                {data.status.ok ? "Connected" : "Down"}
                {data.status.status ? ` · ${data.status.status}` : ""}
              </Badge>
            )}
          </div>

          {isLoading ? (
            <p className="mt-2 text-xs text-muted-foreground">Checking…</p>
          ) : !data?.configured ? (
            <p className="mt-2 text-xs text-muted-foreground">
              No live integration configured yet.
              {isSuper && " Add one in Admin → Integrations."}
            </p>
          ) : (
            <div className="mt-1.5 space-y-0.5">
              <p className="text-sm">
                <span className="font-medium">{data.env!.name}</span>{" "}
                <span className="text-xs text-muted-foreground">({data.env!.id})</span>
              </p>
              <p className="break-all text-xs text-muted-foreground">
                {data.env!.base_url_host}
              </p>
              {data.status && (
                <p
                  className={`text-xs ${
                    data.status.ok
                      ? "text-muted-foreground"
                      : "text-destructive"
                  }`}
                >
                  {data.status.ok ? "OK" : data.status.message}
                  {" · checked "}
                  {new Date(data.status.checkedAt).toLocaleTimeString()}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw
              className={`mr-1.5 h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          {isSuper && (
            <Button size="sm" variant="outline" asChild>
              <Link to="/settings">
                <Settings2 className="mr-1.5 h-4 w-4" /> Manage
              </Link>
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

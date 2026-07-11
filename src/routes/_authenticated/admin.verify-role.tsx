import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useIsSuper } from "@/hooks/useSession";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { CheckCircle2, XCircle, RefreshCw, ShieldCheck, ShieldAlert } from "lucide-react";
import { checkUserRoles } from "@/lib/role-check.functions";

export const Route = createFileRoute("/_authenticated/admin/verify-role")({
  ssr: false,
  head: () => ({ meta: [{ title: "Verify Role — DelayLens" }] }),
  component: VerifyRoleGate,
});

function VerifyRoleGate() {
  const isSuper = useIsSuper();
  if (isSuper === undefined) return <div className="p-6 text-sm text-muted-foreground">Checking permissions…</div>;
  if (!isSuper) return <div className="p-6 text-sm text-destructive">Super admin only.</div>;
  return <VerifyRolePage />;
}

function VerifyRolePage() {
  const [email, setEmail] = useState("shreyansh.singh3011@gmail.com");
  const [query, setQuery] = useState(email);
  const [auto, setAuto] = useState(true);
  const check = useServerFn(checkUserRoles);

  const { data, isFetching, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["role-check", query],
    queryFn: () => check({ data: { email: query } }),
    enabled: !!query,
    refetchInterval: auto ? 3000 : false,
    refetchOnWindowFocus: true,
  });

  // Realtime: refetch whenever user_roles changes for this user
  useEffect(() => {
    if (!data?.userId) return;
    const ch = supabase
      .channel(`role-watch-${data.userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "user_roles", filter: `user_id=eq.${data.userId}` },
        () => refetch(),
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [data?.userId, refetch]);

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Verify user role</h1>
        <p className="text-sm text-muted-foreground">
          Look up a user by email and confirm their roles in real time.
        </p>
      </div>

      <Card className="p-4 space-y-3">
        <div className="flex gap-2">
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setQuery(email.trim().toLowerCase())}
            placeholder="user@example.com"
          />
          <Button onClick={() => setQuery(email.trim().toLowerCase())}>Check</Button>
          <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={auto} onCheckedChange={setAuto} id="auto" />
          <label htmlFor="auto">Auto-refresh every 3s (plus live updates on role changes)</label>
        </div>
      </Card>

      {error && (
        <Card className="p-4 border-destructive">
          <div className="text-destructive text-sm">{(error as Error).message}</div>
        </Card>
      )}

      {data && (
        <Card className="p-4 space-y-3">
          {!data.found ? (
            <div className="flex items-center gap-2 text-destructive">
              <XCircle className="h-5 w-5" />
              <span>No profile found for <b>{data.email}</b></span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                {data.isSuperAdmin ? (
                  <>
                    <ShieldCheck className="h-6 w-6 text-green-600" />
                    <span className="text-lg font-semibold text-green-700">
                      Confirmed: super_admin
                    </span>
                  </>
                ) : (
                  <>
                    <ShieldAlert className="h-6 w-6 text-amber-600" />
                    <span className="text-lg font-semibold text-amber-700">
                      Not a super_admin
                    </span>
                  </>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div><div className="text-muted-foreground">Email</div><div>{data.email}</div></div>
                <div><div className="text-muted-foreground">Name</div><div>{data.fullName || "—"}</div></div>
                <div className="sm:col-span-2">
                  <div className="text-muted-foreground">User ID</div>
                  <div className="font-mono text-xs break-all">{data.userId}</div>
                </div>
                <div className="sm:col-span-2">
                  <div className="text-muted-foreground mb-1">Roles</div>
                  {data.roles.length ? (
                    <div className="flex flex-wrap gap-1">
                      {data.roles.map((r) => (
                        <Badge key={r} variant={r === "super_admin" ? "default" : "secondary"}>
                          {r === "super_admin" && <CheckCircle2 className="h-3 w-3 mr-1" />}
                          {r}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">No roles assigned</span>
                  )}
                </div>
              </div>
            </>
          )}
          <div className="text-xs text-muted-foreground pt-2 border-t">
            Last checked: {new Date(dataUpdatedAt).toLocaleTimeString()}
          </div>
        </Card>
      )}
    </div>
  );
}

import { useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  verifySignupAgainstSheet,
  mySignupStatus,
} from "@/lib/signup-verify.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, Clock, XCircle, ShieldCheck, LogOut } from "lucide-react";

export function PendingApprovalScreen({ email }: { email: string }) {
  const verifyFn = useServerFn(verifySignupAgainstSheet);
  const statusFn = useServerFn(mySignupStatus);

  const statusQ = useQuery({
    queryKey: ["my-signup-status"],
    queryFn: () => statusFn(),
    refetchInterval: 15_000,
  });

  const verify = useMutation({
    mutationFn: () => verifyFn(),
    onSuccess: () => { statusQ.refetch(); },
  });

  // Auto-attempt sheet verification once on mount.
  useEffect(() => { verify.mutate(); /* eslint-disable-next-line */ }, []);

  const s = statusQ.data;
  const rejected = s?.status === "rejected";
  const approved = s?.status === "approved";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md p-8">
        <div className="flex items-center gap-2 text-primary">
          <ShieldCheck className="h-5 w-5" />
          <h1 className="text-lg font-semibold tracking-tight">Access review</h1>
        </div>

        <p className="mt-1 text-xs text-muted-foreground">{email}</p>

        <div className="mt-6 space-y-3 text-sm">
          {verify.isPending && (
            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 p-3">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking allowlist sheet…
            </div>
          )}

          {approved && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-emerald-700">
              <CheckCircle2 className="h-4 w-4" /> Approved — refreshing…
            </div>
          )}

          {rejected && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-rose-700">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <div className="font-medium">Access denied</div>
                {s?.reject_reason && <div className="mt-0.5 text-xs opacity-80">{s.reject_reason}</div>}
              </div>
            </div>
          )}

          {!approved && !rejected && !verify.isPending && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-amber-800">
              <Clock className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <div className="font-medium">Awaiting verification</div>
                <div className="mt-0.5 text-xs opacity-90">
                  {verify.data?.reason ?? "Your account is either verified against the allowlist sheet, or a super admin must approve."}
                </div>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            <Button size="sm" variant="outline" disabled={verify.isPending} onClick={() => verify.mutate()}>
              {verify.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Recheck sheet
            </Button>
            <Button size="sm" variant="outline" onClick={() => statusQ.refetch()}>
              Refresh status
            </Button>
            <Button size="sm" variant="ghost" onClick={async () => { await supabase.auth.signOut(); location.href = "/login"; }}>
              <LogOut className="h-4 w-4" /> Sign out
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// Compat with the `reject_reason` field on PendingRequest.
declare module "@/lib/signup-verify.functions" {
  interface PendingRequest { reject_reason?: string | null }
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useRoles } from "@/hooks/useSession";
import { supabase } from "@/integrations/supabase/client";
import {
  UserPlus, FolderKanban, Mail, Radar, Users, ShieldCheck, ScrollText,
  Lock, CheckCircle2, ShieldAlert, Activity, Crown,
} from "lucide-react";


export const Route = createFileRoute("/_authenticated/admin/")({
  component: AdminIndex,
  head: () => ({
    meta: [
      { title: "Admin — Super Admin pages" },
      { name: "robots", content: "noindex" },
    ],
  }),
});

type Entry = {
  to: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  requires: "admin" | "super_admin";
  live?: number;
};

function AdminIndex() {
  const { data: roles } = useRoles();
  const isAdmin = !!roles?.some((r) => r === "admin" || r === "super_admin");
  const isSuper = !!roles?.includes("super_admin");

  const pendingSignupsQ = useQuery({
    queryKey: ["pending-signups-count"],
    enabled: !!isSuper,
    refetchInterval: 30_000,
    queryFn: async () => {
      const { count } = await supabase
        .from("signup_requests")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending");
      return count ?? 0;
    },
  });

  const entries: Entry[] = [
    {
      to: "/admin/approvals",
      label: "Pending signups",
      description: "Approve, reject, or resend invites for new user requests.",
      icon: <UserPlus className="h-5 w-5" />,
      requires: "super_admin",
      live: pendingSignupsQ.data ?? 0,
    },
    {
      to: "/admin/users",
      label: "Users & roles",
      description: "Grant or revoke roles across every user in the workspace.",
      icon: <Users className="h-5 w-5" />,
      requires: "super_admin",
    },
    {
      to: "/admin/allowlist",
      label: "Signup allowlist",
      description: "Control which email addresses can create accounts.",
      icon: <ShieldCheck className="h-5 w-5" />,
      requires: "super_admin",
    },
    {
      to: "/admin/verify-role",
      label: "Verify role",
      description: "Confirm the roles currently attached to any user.",
      icon: <ShieldAlert className="h-5 w-5" />,
      requires: "super_admin",
    },
    {
      to: "/admin/bootstrap",
      label: "Bootstrap super admins",
      description: "Always-on super_admin accounts that survive DB outages.",
      icon: <Crown className="h-5 w-5" />,
      requires: "super_admin",
    },

    {
      to: "/projects",
      label: "Projects",
      description: "Manage projects and their memberships.",
      icon: <FolderKanban className="h-5 w-5" />,
      requires: "admin",
    },
    {
      to: "/admin/email-groups",
      label: "Email groups",
      description: "Manage distribution lists used by the agent and alerts.",
      icon: <Mail className="h-5 w-5" />,
      requires: "admin",
    },
    {
      to: "/admin/email",
      label: "Email queue",
      description: "Inspect queued, sent, and failed outbound emails.",
      icon: <Mail className="h-5 w-5" />,
      requires: "admin",
    },
    {
      to: "/admin/smart-alerts",
      label: "Smart alerts",
      description: "Configure automated dashboard alert rules.",
      icon: <Radar className="h-5 w-5" />,
      requires: "admin",
    },
    {
      to: "/admin/audit",
      label: "Audit log",
      description: "Review privileged actions across the workspace.",
      icon: <ScrollText className="h-5 w-5" />,
      requires: "admin",
    },
    {
      to: "/admin/health",
      label: "Integration health",
      description: "Live status of AI providers, sheet sync, email, and realtime.",
      icon: <Activity className="h-5 w-5" />,
      requires: "admin",
    },
    {
      to: "/admin/sources-health",
      label: "Sources health",
      description: "Per-sheet sync freshness and per-document embedding coverage.",
      icon: <Activity className="h-5 w-5" />,
      requires: "admin",
    },
    {
      to: "/admin/sync-perf",
      label: "Sync performance",
      description: "Cron run duration, rows changed, and embed-backfill throughput.",
      icon: <Activity className="h-5 w-5" />,
      requires: "admin",
    },
  ];


  const hasAccess = (e: Entry) => (e.requires === "super_admin" ? isSuper : isAdmin);

  const superEntries = entries.filter((e) => e.requires === "super_admin");
  const adminEntries = entries.filter((e) => e.requires === "admin");

  return (
    <div className="mx-auto w-full max-w-5xl p-6 space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="text-sm text-muted-foreground">
          All privileged pages in one place. Your access is shown per card.
        </p>
      </header>

      <Section title="Super admin only" entries={superEntries} hasAccess={hasAccess} />
      <Section title="Admin" entries={adminEntries} hasAccess={hasAccess} />
    </div>
  );
}

function Section({
  title, entries, hasAccess,
}: { title: string; entries: Entry[]; hasAccess: (e: Entry) => boolean }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">{title}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {entries.map((e) => {
          const allowed = hasAccess(e);
          const Card = (
            <div
              className={[
                "group relative flex items-start gap-3 rounded-lg border p-4 transition",
                allowed ? "hover:border-foreground/40 hover:bg-muted/40" : "opacity-60",
              ].join(" ")}
            >
              <div className="mt-0.5 shrink-0 rounded-md bg-muted p-2">{e.icon}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className="font-medium truncate">{e.label}</div>
                  {typeof e.live === "number" && e.live > 0 && (
                    <span className="rounded-full bg-red-500/15 text-red-600 dark:text-red-400 text-xs px-2 py-0.5">
                      {e.live}
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">{e.description}</p>
                <div className="mt-2 flex items-center gap-2 text-xs">
                  {allowed ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Access granted
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <Lock className="h-3.5 w-3.5" /> Requires {e.requires.replace("_", " ")}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
          return allowed ? (
            <Link key={e.to} to={e.to as never} className="block">{Card}</Link>
          ) : (
            <div key={e.to} aria-disabled>{Card}</div>
          );
        })}
      </div>
    </section>
  );
}

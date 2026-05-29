import { createFileRoute, Outlet, redirect, Link, useRouter } from "@tanstack/react-router";
import { useSession, useRoles, useIsAdmin, useIsSuper } from "@/hooks/useSession";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { LogOut, LayoutDashboard, ListChecks, FolderKanban, Users, ScrollText, Bell, CalendarDays } from "lucide-react";

export const Route = createFileRoute("/_authenticated")({
  component: AuthLayout,
});

function AuthLayout() {
  const { session, loading } = useSession();
  const { isLoading: rolesLoading } = useRoles();
  const router = useRouter();
  const isAdmin = useIsAdmin();
  const isSuper = useIsSuper();

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading…</div>;
  }
  if (!session) {
    throw redirect({ to: "/login" });
  }

  const signOut = async () => {
    await supabase.auth.signOut();
    router.navigate({ to: "/login" });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
          <Link to="/_authenticated/dashboard" className="font-semibold tracking-tight">DelayLens</Link>
          <nav className="flex flex-1 items-center gap-1 text-sm">
            <NavLink to="/_authenticated/dashboard" icon={<LayoutDashboard className="h-4 w-4" />}>Dashboard</NavLink>
            <NavLink to="/_authenticated/my-activities" icon={<ListChecks className="h-4 w-4" />}>My Activities</NavLink>
            <NavLink to="/_authenticated/notifications" icon={<Bell className="h-4 w-4" />}>Inbox</NavLink>
            {isAdmin && <NavLink to="/_authenticated/projects" icon={<FolderKanban className="h-4 w-4" />}>Projects</NavLink>}
            {isAdmin && <NavLink to="/_authenticated/admin/holidays" icon={<CalendarDays className="h-4 w-4" />}>Holidays</NavLink>}
            {isSuper && <NavLink to="/_authenticated/admin/users" icon={<Users className="h-4 w-4" />}>Users</NavLink>}
            {isAdmin && <NavLink to="/_authenticated/admin/audit" icon={<ScrollText className="h-4 w-4" />}>Audit</NavLink>}
          </nav>
          <span className="hidden text-xs text-muted-foreground sm:inline">{session.user.email}</span>
          <Button variant="ghost" size="sm" onClick={signOut}>
            <LogOut className="mr-1.5 h-4 w-4" /> Sign out
          </Button>
        </div>
      </header>
      {rolesLoading ? null : <Outlet />}
    </div>
  );
}

function NavLink({ to, icon, children }: { to: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <Link
      to={to as never}
      className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&.active]:bg-accent [&.active]:text-foreground"
      activeProps={{ className: "active" }}
    >
      {icon}
      {children}
    </Link>
  );
}

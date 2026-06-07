import { createFileRoute, Outlet, redirect, Link, useRouter } from "@tanstack/react-router";
import { useSession, useRoles, useIsAdmin, useIsSuper } from "@/hooks/useSession";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/useTheme";
import {
  LogOut, LayoutDashboard, ListChecks, FolderKanban, Users, ScrollText, Bell,
  CalendarDays, Settings, Sun, Moon, Activity, FileText, Sparkles, Sheet as SheetIcon,
  AlertTriangle, Mail, Plug, MessageSquareWarning,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated")({
  component: AuthLayout,
});

function AuthLayout() {
  const { session, loading } = useSession();
  const { isLoading: rolesLoading } = useRoles();
  const router = useRouter();
  const isAdmin = useIsAdmin();
  const isSuper = useIsSuper();
  const { mode, toggle } = useTheme();

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

  const isDark = mode === "dark" || (typeof document !== "undefined" && document.documentElement.classList.contains("dark"));

  return (
    <div className="flex min-h-screen w-full bg-background text-foreground">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-card md:flex">
        <div className="flex h-14 items-center gap-2 px-5 border-b border-border">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <Activity className="h-4 w-4" />
          </div>
          <span className="text-sm font-medium tracking-tight">DelayLens</span>
        </div>
        <nav className="flex-1 space-y-0.5 p-3 text-sm">
          <SideLink to="/dashboard" icon={<LayoutDashboard className="h-4 w-4" />}>Dashboard</SideLink>
          <SideLink to="/my-activities" icon={<ListChecks className="h-4 w-4" />}>My activities</SideLink>
          <SideLink to="/notifications" icon={<Bell className="h-4 w-4" />}>Inbox</SideLink>
          <SideLink to="/alerts" icon={<AlertTriangle className="h-4 w-4" />}>Alerts</SideLink>
          <SideLink to="/concerns" icon={<MessageSquareWarning className="h-4 w-4" />}>Concerns</SideLink>
          <SideLink to="/documents" icon={<FileText className="h-4 w-4" />}>Documents</SideLink>
          <SideLink to="/sheets" icon={<SheetIcon className="h-4 w-4" />}>My Sheets</SideLink>
          <SideLink to="/copilot" icon={<Sparkles className="h-4 w-4" />}>Co-pilot</SideLink>
          {isAdmin && <SideLink to="/projects" icon={<FolderKanban className="h-4 w-4" />}>Projects</SideLink>}
          {isAdmin && <SideLink to="/admin/holidays" icon={<CalendarDays className="h-4 w-4" />}>Holidays</SideLink>}
          {isAdmin && <SideLink to="/admin/email-groups" icon={<Mail className="h-4 w-4" />}>Email groups</SideLink>}
          {isSuper && <SideLink to="/admin/users" icon={<Users className="h-4 w-4" />}>Users</SideLink>}
          {isAdmin && <SideLink to="/admin/audit" icon={<ScrollText className="h-4 w-4" />}>Audit</SideLink>}
          <div className="my-2 h-px bg-border" />
          <SideLink to="/settings" icon={<Settings className="h-4 w-4" />}>Settings</SideLink>
        </nav>
        <div className="border-t border-border p-3 text-xs text-muted-foreground truncate">
          {session.user.email}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-border bg-card/80 px-4 backdrop-blur md:px-6">
          <nav className="flex flex-1 items-center gap-1 overflow-x-auto text-sm md:hidden">
            <SideLink to="/dashboard" icon={<LayoutDashboard className="h-4 w-4" />}>Dashboard</SideLink>
            <SideLink to="/my-activities" icon={<ListChecks className="h-4 w-4" />}>Tasks</SideLink>
            <SideLink to="/notifications" icon={<Bell className="h-4 w-4" />}>Inbox</SideLink>
            <SideLink to="/alerts" icon={<AlertTriangle className="h-4 w-4" />}>Alerts</SideLink>
            <SideLink to="/documents" icon={<FileText className="h-4 w-4" />}>Docs</SideLink>
            <SideLink to="/sheets" icon={<SheetIcon className="h-4 w-4" />}>Sheets</SideLink>
            <SideLink to="/copilot" icon={<Sparkles className="h-4 w-4" />}>Co-pilot</SideLink>
            {isAdmin && <SideLink to="/projects" icon={<FolderKanban className="h-4 w-4" />}>Projects</SideLink>}
            {isAdmin && <SideLink to="/admin/holidays" icon={<CalendarDays className="h-4 w-4" />}>Holidays</SideLink>}
            {isAdmin && <SideLink to="/admin/email-groups" icon={<Mail className="h-4 w-4" />}>Groups</SideLink>}
            {isSuper && <SideLink to="/admin/users" icon={<Users className="h-4 w-4" />}>Users</SideLink>}
            {isAdmin && <SideLink to="/admin/audit" icon={<ScrollText className="h-4 w-4" />}>Audit</SideLink>}
            <SideLink to="/settings" icon={<Settings className="h-4 w-4" />}>Settings</SideLink>
          </nav>
          <div className="hidden flex-1 md:block" />
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            aria-label="Toggle theme"
            className="h-9 w-9"
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={signOut}>
            <LogOut className="mr-1.5 h-4 w-4" /> Sign out
          </Button>
        </header>
        {rolesLoading ? null : <Outlet />}
      </div>
    </div>
  );
}

function SideLink({ to, icon, children }: { to: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <Link
      to={to as never}
      className="flex items-center gap-2 rounded-md px-3 py-2 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground [&.active]:bg-accent [&.active]:text-accent-foreground [&.active]:font-medium"
      activeProps={{ className: "active" }}
    >
      {icon}
      <span className="truncate">{children}</span>
    </Link>
  );
}

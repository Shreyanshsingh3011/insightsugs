import { createFileRoute, Outlet, Link, useRouter } from "@tanstack/react-router";
import { useSession, useRoles } from "@/hooks/useSession";
import { PendingApprovalScreen } from "@/components/PendingApprovalScreen";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/useTheme";
import { useEffect, useRef, useState } from "react";
import { CommandPalette } from "@/components/CommandPalette";
import { NotificationsBell } from "@/components/NotificationsBell";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import {
  LogOut, LayoutDashboard, ListChecks, FolderKanban, Users, ScrollText, Bell,
  Settings, Sun, Moon, FileText, Sparkles, Sheet as SheetIcon,
  AlertTriangle, Mail, MessageSquareWarning, Bot, Inbox, Newspaper, Radar, Search,
  Menu, X, Command, Keyboard, ShieldCheck,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated")({
  component: AuthLayout,
  errorComponent: AuthErrorFallback,
});

function AuthErrorFallback({ error }: { error: unknown }) {
  // A `redirect({ to: "/login" })` thrown from the component during render
  // surfaces here instead of navigating. Perform the navigation on mount.
  const router = useRouter();
  const isRedirect =
    !!error &&
    typeof error === "object" &&
    "options" in (error as Record<string, unknown>) &&
    !!(error as { options?: { to?: string } }).options?.to;
  useEffect(() => {
    if (isRedirect) {
      const to = (error as { options: { to: string } }).options.to;
      router.navigate({ to: to as never, replace: true });
    }
  }, [isRedirect, error, router]);
  if (isRedirect) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <div className="h-2 w-2 animate-pulse rounded-full bg-foreground" />
          Redirecting…
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md text-sm text-muted-foreground">
        Something went wrong loading this page.
      </div>
    </div>
  );
}

type NavItem = { to: string; label: string; icon: React.ReactNode };
type NavSection = { label: string; items: NavItem[] };

function AuthLayout() {
  const { session, loading } = useSession();
  const { data: roles, isLoading: rolesLoading } = useRoles();
  const router = useRouter();
  const isAdmin = !!roles?.some((r) => r === "admin" || r === "super_admin");
  const isSuper = !!roles?.includes("super_admin");
  const { mode, toggle } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const gPrefixAt = useRef<number>(0);

  // Global shortcuts: ⌘K / Ctrl+K palette, ? cheatsheet, g+<key> quick nav.
  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el.isContentEditable
      );
    };

    const onKey = (e: KeyboardEvent) => {
      // ⌘K / Ctrl+K → command palette
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (isTypingTarget(e.target)) return;
      // ? → shortcuts cheatsheet
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      // g <key> quick nav
      const now = Date.now();
      if (e.key.toLowerCase() === "g" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        gPrefixAt.current = now;
        return;
      }
      if (now - gPrefixAt.current < 1200) {
        const map: Record<string, string> = {
          i: "/insights",
          a: "/agent",
          s: "/sheets",
          n: "/notifications",
          c: "/copilot",
        };
        const to = map[e.key.toLowerCase()];
        if (to) {
          e.preventDefault();
          gPrefixAt.current = 0;
          router.navigate({ to: to as never });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <div className="h-2 w-2 animate-pulse rounded-full bg-foreground" />
          Loading workspace
        </div>
      </div>
    );
  }
  if (!session) {
    // Navigate as a side effect; throwing redirect() from a component
    // is caught by the error boundary instead of navigating.
    if (typeof window !== "undefined") {
      const nextPath = `${window.location.pathname}${window.location.search}`;
      if (nextPath.startsWith("/") && !nextPath.startsWith("/login")) {
        window.sessionStorage.setItem("postLoginPath", nextPath);
      }
      router.navigate({ to: "/login", replace: true });
    }
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <div className="h-2 w-2 animate-pulse rounded-full bg-foreground" />
          Redirecting to sign in…
        </div>
      </div>
    );
  }
  if (!rolesLoading && roles && roles.length === 0) {
    return <PendingApprovalScreen email={session.user.email ?? ""} />;
  }

  const signOut = async () => {
    if (typeof window !== "undefined") window.sessionStorage.removeItem("postLoginPath");
    await supabase.auth.signOut();
    router.navigate({ to: "/login", replace: true });
  };

  const isDark = mode === "dark" || (typeof document !== "undefined" && document.documentElement.classList.contains("dark"));

  const sections: NavSection[] = [
    {
      label: "Workspace",
      items: [
        { to: "/agent", label: "Agent", icon: <Bot className="h-4 w-4" /> },
        { to: "/insights", label: "Insights", icon: <LayoutDashboard className="h-4 w-4" /> },
        { to: "/search", label: "Search", icon: <Search className="h-4 w-4" /> },
        { to: "/copilot", label: "Co-pilot", icon: <Sparkles className="h-4 w-4" /> },
      ],
    },
    {
      label: "Activity",
      items: [
        { to: "/agent/inbox", label: "Agent inbox", icon: <Inbox className="h-4 w-4" /> },
        { to: "/my-activities", label: "My activities", icon: <ListChecks className="h-4 w-4" /> },
        { to: "/notifications", label: "Inbox", icon: <Bell className="h-4 w-4" /> },
        { to: "/alerts", label: "Alerts", icon: <AlertTriangle className="h-4 w-4" /> },
        { to: "/concerns", label: "Concerns", icon: <MessageSquareWarning className="h-4 w-4" /> },
      ],
    },
    {
      label: "Library",
      items: [
        { to: "/documents", label: "Documents", icon: <FileText className="h-4 w-4" /> },
        { to: "/sheets", label: "Sheets", icon: <SheetIcon className="h-4 w-4" /> },
        { to: "/briefings", label: "Briefings", icon: <Newspaper className="h-4 w-4" /> },
      ],
    },
  ];

  const adminSection: NavSection | null = isAdmin || isSuper ? {
    label: "Admin",
    items: [
      ...(isAdmin ? [{ to: "/projects", label: "Projects", icon: <FolderKanban className="h-4 w-4" /> }] : []),
      ...(isAdmin ? [{ to: "/admin/email-groups", label: "Email groups", icon: <Mail className="h-4 w-4" /> }] : []),
      ...(isAdmin ? [{ to: "/admin/email", label: "Email queue", icon: <Mail className="h-4 w-4" /> }] : []),
      ...(isAdmin ? [{ to: "/admin/smart-alerts", label: "Smart alerts", icon: <Radar className="h-4 w-4" /> }] : []),
      ...(isSuper ? [{ to: "/admin/users", label: "Users", icon: <Users className="h-4 w-4" /> }] : []),
      ...(isSuper ? [{ to: "/admin/allowlist", label: "Signup allowlist", icon: <ShieldCheck className="h-4 w-4" /> }] : []),
      ...(isAdmin ? [{ to: "/admin/audit", label: "Audit", icon: <ScrollText className="h-4 w-4" /> }] : []),
    ],
  } : null;

  const allSections = adminSection ? [...sections, adminSection] : sections;

  const openPalette = () => setPaletteOpen(true);

  const userInitial = (session.user.email ?? "?").charAt(0).toUpperCase();

  return (
    <div className="flex min-h-screen w-full bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
        <BrandMark />
        <div className="px-3 pb-2">
          <button
            onClick={openPalette}
            className="group flex w-full items-center gap-2 rounded-lg border border-border bg-background/60 px-3 py-2 text-left text-sm text-muted-foreground transition-all hover:border-foreground/20 hover:bg-background hover:text-foreground"
          >
            <Search className="h-4 w-4" />
            <span className="flex-1">Search everything</span>
            <kbd className="hidden items-center gap-0.5 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground lg:inline-flex">
              <Command className="h-2.5 w-2.5" />K
            </kbd>
          </button>
        </div>
        <nav className="flex-1 space-y-4 overflow-y-auto p-3 pt-2 text-sm">
          {allSections.map((section) => (
            <NavGroup key={section.label} section={section} />
          ))}
          <div className="pt-1">
            <SideLink to="/settings" icon={<Settings className="h-4 w-4" />}>Settings</SideLink>
          </div>
        </nav>
        <UserFooter email={session.user.email ?? ""} initial={userInitial} onSignOut={signOut} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-border bg-background/80 px-4 backdrop-blur-md md:px-6">
          <button
            className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <button
            onClick={openPalette}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
          >
            <Search className="h-4 w-4" />
            <span>Search</span>
          </button>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon"
            onClick={openPalette}
            aria-label="Open command palette"
            className="hidden h-9 w-9 md:inline-flex"
          >
            <Command className="h-4 w-4" />
          </Button>
          <NotificationsBell />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShortcutsOpen(true)}
            aria-label="Keyboard shortcuts"
            className="hidden h-9 w-9 md:inline-flex"
          >
            <Keyboard className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            aria-label="Toggle theme"
            className="h-9 w-9"
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={signOut} className="hidden md:inline-flex">
            <LogOut className="mr-1.5 h-4 w-4" /> Sign out
          </Button>
        </header>
        <Outlet />
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog">
          <button
            aria-label="Close menu"
            className="absolute inset-0 bg-foreground/40 backdrop-blur-sm animate-in fade-in-0"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative ml-auto flex h-full w-72 flex-col border-l border-border bg-sidebar animate-in slide-in-from-right duration-200">
            <div className="flex items-center justify-between border-b border-border px-4 h-14">
              <BrandMark compact />
              <button
                onClick={() => setMobileOpen(false)}
                className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav
              className="flex-1 space-y-4 overflow-y-auto p-3 text-sm"
              onClick={() => setMobileOpen(false)}
            >
              {allSections.map((section) => (
                <NavGroup key={section.label} section={section} />
              ))}
              <div className="pt-1">
                <SideLink to="/settings" icon={<Settings className="h-4 w-4" />}>Settings</SideLink>
              </div>
            </nav>
            <UserFooter email={session.user.email ?? ""} initial={userInitial} onSignOut={signOut} />
          </aside>
        </div>
      )}

      {/* Global overlays */}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onOpenShortcuts={() => setShortcutsOpen(true)}
      />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}

function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`flex items-center gap-2.5 ${compact ? "" : "h-14 border-b border-border px-4"}`}>
      <div className="relative grid h-8 w-8 place-items-center rounded-lg bg-foreground text-background shadow-sm">
        <span className="font-display text-[13px] font-bold tracking-tight">DL</span>
        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-success ring-2 ring-sidebar" />
      </div>
      <div className="flex flex-col leading-tight">
        <span className="font-display text-sm font-semibold tracking-tight">DelayLens</span>
        <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Intelligence</span>
      </div>
    </div>
  );
}

function NavGroup({ section }: { section: NavSection }) {
  if (section.items.length === 0) return null;
  return (
    <div>
      <div className="px-3 pb-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
        {section.label}
      </div>
      <div className="space-y-0.5">
        {section.items.map((item) => (
          <SideLink key={item.to} to={item.to} icon={item.icon}>{item.label}</SideLink>
        ))}
      </div>
    </div>
  );
}

function UserFooter({ email, initial, onSignOut }: { email: string; initial: string; onSignOut: () => void }) {
  return (
    <div className="flex items-center gap-2 border-t border-border p-3">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
        {initial}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-foreground">{email}</div>
        <div className="text-[10px] text-muted-foreground">Signed in</div>
      </div>
      <button
        onClick={onSignOut}
        className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="Sign out"
      >
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  );
}

function SideLink({ to, icon, children }: { to: string; icon: React.ReactNode; children: React.ReactNode }) {
  const currentPath = useRouterState({ select: (r) => r.location.pathname });
  const active = currentPath === to || (to !== "/" && currentPath.startsWith(to + "/"));
  return (
    <Link
      to={to as never}
      className={`group relative flex items-center gap-2.5 rounded-lg px-3 py-2 transition-all duration-150 ${
        active
          ? "bg-foreground text-background shadow-sm"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      }`}
    >
      <span className={`transition-transform duration-150 ${active ? "" : "group-hover:scale-110"}`}>
        {icon}
      </span>
      <span className="truncate">{children}</span>
    </Link>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRoles } from "@/hooks/useSession";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Bot, LayoutDashboard, Search, Sparkles, Inbox, ListChecks, Bell,
  AlertTriangle, MessageSquareWarning, FileText, Sheet as SheetIcon,
  Newspaper, Users, Radar, Mail, ScrollText, Settings, FolderKanban,
  Zap, Sun, Moon, Keyboard, PlayCircle,
} from "lucide-react";
import { useTheme } from "@/hooks/useTheme";

type Cmd = {
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon: React.ReactNode;
  run: () => void;
  group: string;
};

export function CommandPalette({
  open,
  onOpenChange,
  onOpenShortcuts,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onOpenShortcuts: () => void;
}) {
  const navigate = useNavigate();
  const { data: roles } = useRoles();
  const isAdmin = !!roles?.some((r) => r === "admin" || r === "super_admin");
  const isSuper = !!roles?.includes("super_admin");
  const { toggle: toggleTheme, mode } = useTheme();
  const [query, setQuery] = useState("");

  // Lazy-load contextual data only while the palette is open.
  const projectsQ = useQuery({
    queryKey: ["cmdk", "projects"],
    enabled: open,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("projects")
        .select("id, name")
        .order("name", { ascending: true })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });

  const sheetsQ = useQuery({
    queryKey: ["cmdk", "sheets"],
    enabled: open,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sheet_registry")
        .select("id, display_name, sheet_type")
        .order("display_name", { ascending: true })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });

  const agentsQ = useQuery({
    queryKey: ["cmdk", "agents"],
    enabled: open,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("custom_agents")
        .select("id, name")
        .order("name", { ascending: true })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const go = (to: string, params?: Record<string, string>) => {
    onOpenChange(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    navigate({ to: to as never, params: params as any });
  };

  const navCommands: Cmd[] = useMemo(() => {
    const base: Cmd[] = [
      { id: "nav:agent", group: "Navigate", label: "Agent", icon: <Bot className="h-4 w-4" />, run: () => go("/agent") },
      { id: "nav:insights", group: "Navigate", label: "Insights", icon: <LayoutDashboard className="h-4 w-4" />, run: () => go("/insights") },
      { id: "nav:search", group: "Navigate", label: "Search", icon: <Search className="h-4 w-4" />, run: () => go("/search") },
      { id: "nav:copilot", group: "Navigate", label: "Co-pilot", icon: <Sparkles className="h-4 w-4" />, run: () => go("/copilot") },
      { id: "nav:agent-inbox", group: "Navigate", label: "Agent inbox", icon: <Inbox className="h-4 w-4" />, run: () => go("/agent/inbox") },
      { id: "nav:my-acts", group: "Navigate", label: "My activities", icon: <ListChecks className="h-4 w-4" />, run: () => go("/my-activities") },
      { id: "nav:inbox", group: "Navigate", label: "Inbox / Notifications", icon: <Bell className="h-4 w-4" />, run: () => go("/notifications") },
      { id: "nav:alerts", group: "Navigate", label: "Alerts", icon: <AlertTriangle className="h-4 w-4" />, run: () => go("/alerts") },
      { id: "nav:concerns", group: "Navigate", label: "Concerns", icon: <MessageSquareWarning className="h-4 w-4" />, run: () => go("/concerns") },
      { id: "nav:docs", group: "Navigate", label: "Documents", icon: <FileText className="h-4 w-4" />, run: () => go("/documents") },
      { id: "nav:sheets", group: "Navigate", label: "Sheets", icon: <SheetIcon className="h-4 w-4" />, run: () => go("/sheets") },
      { id: "nav:ingest", group: "Navigate", label: "Data ingestion", icon: <Zap className="h-4 w-4" />, run: () => go("/ingest") },
      { id: "nav:briefings", group: "Navigate", label: "Briefings", icon: <Newspaper className="h-4 w-4" />, run: () => go("/briefings") },
      { id: "nav:settings", group: "Navigate", label: "Settings", icon: <Settings className="h-4 w-4" />, run: () => go("/settings") },
    ];
    if (isAdmin) {
      base.push(
        { id: "nav:projects", group: "Admin", label: "Projects", icon: <FolderKanban className="h-4 w-4" />, run: () => go("/projects") },
        { id: "nav:egroups", group: "Admin", label: "Email groups", icon: <Mail className="h-4 w-4" />, run: () => go("/admin/email-groups") },
        { id: "nav:salerts", group: "Admin", label: "Smart alerts", icon: <Radar className="h-4 w-4" />, run: () => go("/admin/smart-alerts") },
        { id: "nav:audit", group: "Admin", label: "Audit", icon: <ScrollText className="h-4 w-4" />, run: () => go("/admin/audit") },
      );
    }
    if (isSuper) {
      base.push({ id: "nav:users", group: "Admin", label: "Users", icon: <Users className="h-4 w-4" />, run: () => go("/admin/users") });
    }
    return base;
  }, [isAdmin, isSuper]); // eslint-disable-line react-hooks/exhaustive-deps

  const actionCommands: Cmd[] = useMemo(() => [
    {
      id: "act:theme",
      group: "Actions",
      label: mode === "dark" ? "Switch to light theme" : "Switch to dark theme",
      icon: mode === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />,
      run: () => { toggleTheme(); onOpenChange(false); },
    },
    {
      id: "act:shortcuts",
      group: "Actions",
      label: "Keyboard shortcuts",
      hint: "?",
      icon: <Keyboard className="h-4 w-4" />,
      run: () => { onOpenChange(false); onOpenShortcuts(); },
    },
    {
      id: "act:run-agent",
      group: "Actions",
      label: "Run an agent…",
      icon: <PlayCircle className="h-4 w-4" />,
      run: () => go("/agent/custom"),
    },
    {
      id: "act:planner",
      group: "Actions",
      label: "Multi-step planner…",
      icon: <Sparkles className="h-4 w-4" />,
      run: () => go("/agent/planner"),
    },

  ], [mode, toggleTheme, onOpenChange, onOpenShortcuts]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder="Jump to a page, project, sheet, or run an action…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No matches found.</CommandEmpty>

        <CommandGroup heading="Actions">
          {actionCommands.map((c) => (
            <CommandItem key={c.id} value={`${c.group} ${c.label} ${c.keywords ?? ""}`} onSelect={c.run}>
              {c.icon}
              <span>{c.label}</span>
              {c.hint && (
                <kbd className="ml-auto rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {c.hint}
                </kbd>
              )}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Navigate">
          {navCommands.filter((c) => c.group === "Navigate").map((c) => (
            <CommandItem key={c.id} value={`nav ${c.label}`} onSelect={c.run}>
              {c.icon}
              <span>{c.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        {navCommands.some((c) => c.group === "Admin") && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Admin">
              {navCommands.filter((c) => c.group === "Admin").map((c) => (
                <CommandItem key={c.id} value={`admin ${c.label}`} onSelect={c.run}>
                  {c.icon}
                  <span>{c.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {projectsQ.data && projectsQ.data.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Projects">
              {projectsQ.data.map((p) => (
                <CommandItem
                  key={`proj:${p.id}`}
                  value={`project ${p.name}`}
                  onSelect={() => go("/agent/project/$projectId", { projectId: p.id })}
                >
                  <FolderKanban className="h-4 w-4" />
                  <span className="truncate">{p.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {sheetsQ.data && sheetsQ.data.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Sheets">
              {sheetsQ.data.map((s) => (
                <CommandItem
                  key={`sheet:${s.id}`}
                  value={`sheet ${s.display_name} ${s.sheet_type ?? ""}`}
                  onSelect={() => go("/sheets/$sheetId", { sheetId: s.id })}
                >
                  <SheetIcon className="h-4 w-4" />
                  <span className="truncate">{s.display_name ?? "Untitled sheet"}</span>
                  {s.sheet_type && (
                    <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                      {s.sheet_type}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {agentsQ.data && agentsQ.data.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Agents">
              {agentsQ.data.map((a) => (
                <CommandItem
                  key={`agent:${a.id}`}
                  value={`agent ${a.name}`}
                  onSelect={() => go("/agent/custom")}
                >
                  <Bot className="h-4 w-4" />
                  <span className="truncate">{a.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}

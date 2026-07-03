import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listShareableUsers } from "@/lib/documents.functions";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Check, Globe, Lock, Users, X } from "lucide-react";

export type Visibility = "private" | "public" | "shared";

export function VisibilityBadge({
  visibility,
  shareCount,
  size = "sm",
}: {
  visibility: Visibility;
  shareCount?: number;
  size?: "sm" | "xs";
}) {
  const cls = size === "xs" ? "text-[10px] px-1.5 py-0" : "";
  if (visibility === "public") {
    return (
      <Badge variant="outline" className={`gap-1 border-blue-500/40 text-blue-700 dark:text-blue-400 ${cls}`}>
        <Globe className="h-3 w-3" /> Public
      </Badge>
    );
  }
  if (visibility === "shared") {
    return (
      <Badge variant="outline" className={`gap-1 border-amber-500/40 text-amber-700 dark:text-amber-400 ${cls}`}>
        <Users className="h-3 w-3" /> Shared{shareCount ? ` · ${shareCount}` : ""}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={`gap-1 text-muted-foreground ${cls}`}>
      <Lock className="h-3 w-3" /> Private
    </Badge>
  );
}

export function VisibilityPicker({
  visibility,
  onVisibilityChange,
  sharedUserIds,
  onSharedUserIdsChange,
}: {
  visibility: Visibility;
  onVisibilityChange: (v: Visibility) => void;
  sharedUserIds: string[];
  onSharedUserIdsChange: (ids: string[]) => void;
}) {
  const fetchUsers = useServerFn(listShareableUsers);
  const users = useQuery({
    queryKey: ["shareable-users"],
    queryFn: () => fetchUsers(),
    enabled: visibility === "shared",
  });
  const [q, setQ] = useState("");

  const options = useMemo(() => {
    const all = (users.data?.users ?? []) as { id: string; full_name: string; email: string }[];
    if (!q.trim()) return all;
    const needle = q.trim().toLowerCase();
    return all.filter(
      (u) =>
        (u.full_name ?? "").toLowerCase().includes(needle) ||
        (u.email ?? "").toLowerCase().includes(needle),
    );
  }, [users.data, q]);

  const selected = new Set(sharedUserIds);
  const toggle = (id: string) => {
    if (selected.has(id)) onSharedUserIdsChange(sharedUserIds.filter((x) => x !== id));
    else onSharedUserIdsChange([...sharedUserIds, id]);
  };

  const opts: { value: Visibility; label: string; icon: any; hint: string }[] = [
    { value: "private", label: "Private", icon: Lock, hint: "Only you & admins" },
    { value: "public", label: "Public", icon: Globe, hint: "All signed-in users" },
    { value: "shared", label: "Shared", icon: Users, hint: "Pick specific users" },
  ];

  return (
    <div className="space-y-3">
      <div>
        <Label>Visibility</Label>
        <div className="mt-1.5 grid grid-cols-3 gap-2">
          {opts.map((o) => {
            const active = visibility === o.value;
            const Icon = o.icon;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => onVisibilityChange(o.value)}
                className={`flex flex-col items-start gap-0.5 rounded-md border p-2 text-left text-xs transition ${
                  active
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/40"
                }`}
              >
                <span className="flex items-center gap-1.5 font-medium">
                  <Icon className="h-3.5 w-3.5" /> {o.label}
                </span>
                <span className="text-[11px] text-muted-foreground">{o.hint}</span>
              </button>
            );
          })}
        </div>
      </div>

      {visibility === "shared" && (
        <div>
          <Label>Share with</Label>
          <Input
            className="mt-1.5"
            placeholder="Search by name or email"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="mt-2 max-h-52 overflow-y-auto rounded-md border border-border">
            {users.isLoading ? (
              <div className="p-3 text-xs text-muted-foreground">Loading users…</div>
            ) : options.length === 0 ? (
              <div className="p-3 text-xs text-muted-foreground">No users found.</div>
            ) : (
              options.map((u) => {
                const active = selected.has(u.id);
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => toggle(u.id)}
                    className={`flex w-full items-center justify-between gap-2 border-b border-border/60 px-3 py-2 text-left text-xs last:border-b-0 hover:bg-accent ${
                      active ? "bg-accent/60" : ""
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium">{u.full_name || u.email || u.id}</div>
                      {u.full_name && u.email && (
                        <div className="truncate text-[11px] text-muted-foreground">{u.email}</div>
                      )}
                    </div>
                    {active ? (
                      <Check className="h-4 w-4 text-primary" />
                    ) : (
                      <span className="h-4 w-4" />
                    )}
                  </button>
                );
              })
            )}
          </div>
          {sharedUserIds.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {sharedUserIds.map((id) => {
                const u = (users.data?.users ?? []).find((x: any) => x.id === id);
                return (
                  <Badge key={id} variant="secondary" className="gap-1">
                    {u?.full_name || u?.email || id.slice(0, 6)}
                    <button
                      type="button"
                      onClick={() => toggle(id)}
                      className="ml-0.5 hover:text-destructive"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

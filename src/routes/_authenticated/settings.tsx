import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useTheme, type ThemeMode } from "@/hooks/useTheme";
import { useDashboardWidgets, type WidgetConfig } from "@/hooks/useDashboardWidgets";
import { useSession } from "@/hooks/useSession";
import { Sun, Moon, Monitor, GripVertical, RotateCcw, Eye, EyeOff } from "lucide-react";
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [{ title: "Settings — DelayLens" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const { session } = useSession();
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Manage your appearance, dashboard layout and notifications.</p>
      </div>

      <ThemeCard />
      <ProfileCard email={session?.user.email ?? ""} />
      <NotificationsCard />
      <WidgetsCard />
    </main>
  );
}

function SectionCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card className="mb-5 border border-border bg-card p-6 shadow-none rounded-xl">
      <h2 className="text-base font-medium">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-5">{children}</div>
    </Card>
  );
}

function ThemeCard() {
  const { mode, setMode } = useTheme();
  const opts: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
    { value: "light", label: "Light", icon: <Sun className="h-4 w-4" /> },
    { value: "dark", label: "Dark", icon: <Moon className="h-4 w-4" /> },
    { value: "system", label: "System", icon: <Monitor className="h-4 w-4" /> },
  ];
  return (
    <SectionCard title="Appearance" description="Choose how DelayLens looks. System follows your OS setting.">
      <div className="grid grid-cols-3 gap-2">
        {opts.map((o) => (
          <button
            key={o.value}
            onClick={() => setMode(o.value)}
            className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
              mode === o.value
                ? "border-primary bg-accent text-accent-foreground"
                : "border-border hover:bg-accent/50"
            }`}
          >
            {o.icon}
            {o.label}
          </button>
        ))}
      </div>
    </SectionCard>
  );
}

function ProfileCard({ email }: { email: string }) {
  const [name, setName] = useState("");
  return (
    <SectionCard title="Profile" description="Your account details.">
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Email</label>
          <Input value={email} disabled className="mt-1" />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Display name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" className="mt-1" />
        </div>
        <Button size="sm" onClick={() => toast.success("Profile saved")}>Save changes</Button>
      </div>
    </SectionCard>
  );
}

const NOTIF_KEY = "delaylens.notif.v1";
type NotifPrefs = { email_overdue: boolean; email_weekly: boolean; inapp_assignments: boolean };

function loadNotif(): NotifPrefs {
  if (typeof window === "undefined") return { email_overdue: true, email_weekly: true, inapp_assignments: true };
  try { return { email_overdue: true, email_weekly: true, inapp_assignments: true, ...JSON.parse(localStorage.getItem(NOTIF_KEY) || "{}") }; }
  catch { return { email_overdue: true, email_weekly: true, inapp_assignments: true }; }
}

function NotificationsCard() {
  const [prefs, setPrefs] = useState<NotifPrefs>(loadNotif);
  const update = (k: keyof NotifPrefs, v: boolean) => {
    const next = { ...prefs, [k]: v };
    setPrefs(next);
    try { localStorage.setItem(NOTIF_KEY, JSON.stringify(next)); } catch {}
  };
  const Row = ({ k, label, desc }: { k: keyof NotifPrefs; label: string; desc: string }) => (
    <div className="flex items-center justify-between border-b border-border py-3 last:border-0">
      <div className="pr-4">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{desc}</p>
      </div>
      <Switch checked={prefs[k]} onCheckedChange={(v) => update(k, v)} />
    </div>
  );
  return (
    <SectionCard title="Notifications" description="Control what you get notified about.">
      <Row k="email_overdue" label="Overdue email alerts" desc="Email me when an assigned activity becomes overdue." />
      <Row k="email_weekly" label="Weekly digest" desc="Send me the weekly summary report." />
      <Row k="inapp_assignments" label="In-app assignment alerts" desc="Notify in inbox when I'm assigned a new activity." />
    </SectionCard>
  );
}

function WidgetsCard() {
  const { widgets, save, toggle, reset } = useDashboardWidgets();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = widgets.findIndex((w) => w.id === active.id);
    const to = widgets.findIndex((w) => w.id === over.id);
    if (from < 0 || to < 0) return;
    save(arrayMove(widgets, from, to));
  };

  return (
    <SectionCard
      title="Dashboard widgets"
      description="Drag to reorder. Toggle to show or hide widgets on the dashboard."
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={widgets.map((w) => w.id)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-2">
            {widgets.map((w) => (
              <SortableRow key={w.id} widget={w} onToggle={() => toggle(w.id)} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      <div className="mt-4 flex justify-end">
        <Button variant="outline" size="sm" onClick={reset}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset to default
        </Button>
      </div>
    </SectionCard>
  );
}

function SortableRow({ widget, onToggle }: { widget: WidgetConfig; onToggle: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: widget.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2.5"
    >
      <button {...attributes} {...listeners} className="cursor-grab text-muted-foreground hover:text-foreground" aria-label="Drag">
        <GripVertical className="h-4 w-4" />
      </button>
      <span className={`flex-1 text-sm ${widget.visible ? "" : "text-muted-foreground line-through"}`}>
        {widget.label}
      </span>
      <Button variant="ghost" size="sm" onClick={onToggle} className="h-7 px-2">
        {widget.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
      </Button>
    </li>
  );
}

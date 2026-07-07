import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Keyboard } from "lucide-react";

type Shortcut = { keys: string[]; label: string };
type Section = { title: string; items: Shortcut[] };

const SECTIONS: Section[] = [
  {
    title: "Global",
    items: [
      { keys: ["⌘", "K"], label: "Open command palette (Ctrl+K on Windows/Linux)" },
      { keys: ["?"], label: "Show this shortcuts dialog" },
      { keys: ["Esc"], label: "Close dialog / palette" },
    ],
  },
  {
    title: "Navigation",
    items: [
      { keys: ["g", "i"], label: "Go to Insights" },
      { keys: ["g", "a"], label: "Go to Agent" },
      { keys: ["g", "s"], label: "Go to Sheets" },
      { keys: ["g", "n"], label: "Go to Inbox / Notifications" },
      { keys: ["g", "c"], label: "Go to Co-pilot" },
    ],
  },
  {
    title: "Chat & Co-pilot",
    items: [
      { keys: ["⌘", "Enter"], label: "Send message" },
      { keys: ["Shift", "Enter"], label: "New line in composer" },
    ],
  },
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium text-foreground shadow-sm">
      {children}
    </kbd>
  );
}

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-4 w-4" />
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription>
            Faster ways to navigate and act inside DelayLens.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-5">
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {section.title}
              </div>
              <ul className="divide-y divide-border/60 overflow-hidden rounded-md border border-border/60">
                {section.items.map((s) => (
                  <li key={s.label} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="text-foreground">{s.label}</span>
                    <span className="flex items-center gap-1">
                      {s.keys.map((k, i) => (
                        <span key={i} className="flex items-center gap-1">
                          {i > 0 && <span className="text-[10px] text-muted-foreground">then</span>}
                          <Kbd>{k}</Kbd>
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

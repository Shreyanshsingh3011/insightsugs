import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { saveCopilotSynonym } from "@/lib/copilot-synonyms.functions";

type SheetOption = { id: string; label: string };
type Mode = "column" | "verb";

const CANONICAL_INTENTS = [
  { value: "distribution", label: "Break down / group by (distribution)" },
  { value: "causal",       label: "Why / cause (causal)" },
  { value: "compare",      label: "Compare / vs (comparison)" },
  { value: "trend",        label: "Trend / over time" },
  { value: "top",          label: "Top / highest" },
  { value: "bottom",       label: "Bottom / lowest" },
  { value: "aggregate",    label: "Sum / average (aggregate)" },
  { value: "count",        label: "Count / how many" },
  { value: "temporal",     label: "Due / expiring / date window" },
  { value: "predict",      label: "Predict / forecast" },
  { value: "summarize",    label: "Summarize / overview" },
  { value: "filter",       label: "Filter / where" },
  { value: "lookup",       label: "Look up / find" },
  { value: "list",         label: "List / all" },
] as const;

export function TeachCopilotDialog({
  open,
  onOpenChange,
  unmatchedTerms,
  sheets,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unmatchedTerms: string[];
  sheets: SheetOption[];
}) {
  const [mode, setMode] = useState<Mode>("column");
  const [term, setTerm] = useState("");
  const [sheetId, setSheetId] = useState<string>("__none");
  const [columnName, setColumnName] = useState("");
  const [value, setValue] = useState("");
  const [intent, setIntent] = useState<string>("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (open) {
      setMode("column");
      setTerm(unmatchedTerms[0] ?? "");
      setSheetId("__none");
      setColumnName("");
      setValue("");
      setIntent("");
      setNote("");
    }
  }, [open, unmatchedTerms]);

  const qc = useQueryClient();
  const save = useServerFn(saveCopilotSynonym);
  const mut = useMutation({
    mutationFn: (input: {
      term: string;
      sheet_id: string | null;
      column_name: string | null;
      value: string | null;
      intent: (typeof CANONICAL_INTENTS)[number]["value"] | null;
      note: string | null;
    }) => save({ data: input }),
    onSuccess: () => {
      toast.success("Copilot will remember that mapping for next time.");
      qc.invalidateQueries({ queryKey: ["copilot-synonyms"] });
      onOpenChange(false);
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Couldn't save mapping"),
  });

  const canSave =
    term.trim().length > 0 &&
    (mode === "verb"
      ? intent.length > 0
      : sheetId !== "__none" || columnName.trim() || value.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Teach Copilot</DialogTitle>
          <DialogDescription>
            Map a word or phrase either to a specific sheet/column/value in
            your data, or to a canonical action so Copilot routes the query
            correctly next time.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Mode toggle */}
          <div className="flex gap-1.5 rounded-md border p-1">
            <button
              type="button"
              onClick={() => setMode("column")}
              className={`flex-1 rounded px-2 py-1 text-xs ${
                mode === "column" ? "bg-primary text-primary-foreground" : "hover:bg-muted"
              }`}
            >
              Term → sheet/column/value
            </button>
            <button
              type="button"
              onClick={() => setMode("verb")}
              className={`flex-1 rounded px-2 py-1 text-xs ${
                mode === "verb" ? "bg-primary text-primary-foreground" : "hover:bg-muted"
              }`}
            >
              Phrase → action (verb)
            </button>
          </div>

          {unmatchedTerms.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {unmatchedTerms.slice(0, 6).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTerm(t)}
                  className={`rounded-full border px-2 py-0.5 text-xs ${
                    term === t
                      ? "border-primary bg-primary/10"
                      : "hover:border-primary"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="syn-term">
              {mode === "verb" ? "Your phrase" : "Your term"}
            </Label>
            <Input
              id="syn-term"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder={mode === "verb" ? "e.g. crunch, slice, bifurcate" : "e.g. NBPDCL 48"}
            />
          </div>

          {mode === "verb" ? (
            <div className="space-y-1.5">
              <Label htmlFor="syn-intent">Should behave like</Label>
              <Select value={intent} onValueChange={setIntent}>
                <SelectTrigger id="syn-intent">
                  <SelectValue placeholder="Pick an action" />
                </SelectTrigger>
                <SelectContent>
                  {CANONICAL_INTENTS.map((i) => (
                    <SelectItem key={i.value} value={i.value}>
                      {i.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Example: teach "crunch" → distribution so "crunch stock uom" groups the
                sheet by the <code>stock uom</code> column.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="syn-sheet">Sheet (optional)</Label>
                <Select value={sheetId} onValueChange={setSheetId}>
                  <SelectTrigger id="syn-sheet">
                    <SelectValue placeholder="Any sheet" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Any sheet</SelectItem>
                    {sheets.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="syn-col">Column (optional)</Label>
                  <Input
                    id="syn-col"
                    value={columnName}
                    onChange={(e) => setColumnName(e.target.value)}
                    placeholder="e.g. NIT No."
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="syn-val">Value (optional)</Label>
                  <Input
                    id="syn-val"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder="e.g. NIT-48/2024"
                  />
                </div>
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="syn-note">Note (optional)</Label>
            <Input
              id="syn-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why this mapping"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canSave || mut.isPending}
            onClick={() =>
              mut.mutate({
                term: term.trim(),
                sheet_id: mode === "verb" ? null : sheetId === "__none" ? null : sheetId,
                column_name: mode === "verb" ? null : columnName.trim() || null,
                value: mode === "verb" ? null : value.trim() || null,
                intent: mode === "verb"
                  ? (intent as (typeof CANONICAL_INTENTS)[number]["value"])
                  : null,
                note: note.trim() || null,
              })
            }
          >
            {mut.isPending ? "Saving…" : "Save mapping"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

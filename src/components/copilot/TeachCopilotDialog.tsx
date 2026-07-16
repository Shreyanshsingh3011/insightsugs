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
  const [term, setTerm] = useState("");
  const [sheetId, setSheetId] = useState<string>("__none");
  const [columnName, setColumnName] = useState("");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (open) {
      setTerm(unmatchedTerms[0] ?? "");
      setSheetId("__none");
      setColumnName("");
      setValue("");
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
    (sheetId !== "__none" || columnName.trim() || value.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Teach Copilot a synonym</DialogTitle>
          <DialogDescription>
            Map a term you use to the exact sheet, column, or value in your
            data. Copilot will resolve it automatically next time.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
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
            <Label htmlFor="syn-term">Your term</Label>
            <Input
              id="syn-term"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="e.g. NBPDCL 48"
            />
          </div>

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
                sheet_id: sheetId === "__none" ? null : sheetId,
                column_name: columnName.trim() || null,
                value: value.trim() || null,
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

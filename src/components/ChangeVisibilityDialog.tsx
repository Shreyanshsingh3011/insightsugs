import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { VisibilityPicker, type Visibility } from "./VisibilityPicker";
import {
  getDocumentShares,
  updateDocumentVisibility,
} from "@/lib/documents.functions";
import {
  getSheetShares,
  updateSheetVisibility,
} from "@/lib/sheets.functions";

type Kind = "document" | "sheet";

export function ChangeVisibilityDialog({
  open,
  onOpenChange,
  kind,
  id,
  name,
  currentVisibility,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  kind: Kind;
  id: string | null;
  name: string;
  currentVisibility: Visibility;
}) {
  const qc = useQueryClient();
  const [visibility, setVisibility] = useState<Visibility>(currentVisibility);
  const [ids, setIds] = useState<string[]>([]);

  const getSharesDoc = useServerFn(getDocumentShares);
  const getSharesSheet = useServerFn(getSheetShares);
  const updateDoc = useServerFn(updateDocumentVisibility);
  const updateSheet = useServerFn(updateSheetVisibility);

  const shares = useQuery({
    queryKey: [kind, "shares", id],
    enabled: !!id && open && currentVisibility === "shared",
    queryFn: () =>
      kind === "document"
        ? getSharesDoc({ data: { id: id! } })
        : getSharesSheet({ data: { registryId: id! } }),
  });

  useEffect(() => {
    if (open) {
      setVisibility(currentVisibility);
      setIds([]);
    }
  }, [open, currentVisibility]);

  useEffect(() => {
    if (shares.data?.user_ids) setIds(shares.data.user_ids);
  }, [shares.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!id) throw new Error("Missing id");
      if (kind === "document") {
        return updateDoc({ data: { id, visibility, shared_user_ids: ids } });
      }
      return updateSheet({
        data: { registryId: id, visibility, sharedUserIds: ids },
      });
    },
    onSuccess: () => {
      toast.success("Visibility updated");
      qc.invalidateQueries({ queryKey: kind === "document" ? ["documents"] : ["sheets-list"] });
      onOpenChange(false);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="truncate">Visibility · {name}</DialogTitle>
        </DialogHeader>
        <VisibilityPicker
          visibility={visibility}
          onVisibilityChange={setVisibility}
          sharedUserIds={ids}
          onSharedUserIdsChange={setIds}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

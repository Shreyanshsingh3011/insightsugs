// Dashboard toggle that persists the user's preferred document-match mode
// for summarizeThread ("keyword" vs "expanded"). Stored in agent_preferences
// under key="brief_match_mode" so it survives across sessions and is read
// by any UI that later calls summarizeThread.
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/hooks/useSession";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

const KEY = "brief_match_mode";

export type BriefMatchMode = "keyword" | "expanded";

export function useBriefMatchMode(): BriefMatchMode {
  const { userId } = useSession();
  const { data } = useQuery({
    queryKey: ["agent-pref", KEY, userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data } = await supabase
        .from("agent_preferences")
        .select("value")
        .eq("user_id", userId!)
        .eq("key", KEY)
        .maybeSingle();
      const raw =
        data?.value && typeof data.value === "object" && "mode" in (data.value as object)
          ? (data.value as { mode?: string }).mode
          : undefined;
      return raw === "expanded" ? "expanded" : "keyword";
    },
  });
  return data ?? "keyword";
}

export function BriefMatchModeToggle() {
  const { userId } = useSession();
  const qc = useQueryClient();
  const current = useBriefMatchMode();
  const [local, setLocal] = useState<BriefMatchMode>(current);
  useEffect(() => setLocal(current), [current]);

  const save = useMutation({
    mutationFn: async (mode: BriefMatchMode) => {
      if (!userId) throw new Error("Not signed in");
      const { error } = await supabase
        .from("agent_preferences")
        .upsert(
          { user_id: userId, key: KEY, value: { mode } as never },
          { onConflict: "user_id,key" },
        );
      if (error) throw error;
      return mode;
    },
    onSuccess: (mode) => {
      qc.invalidateQueries({ queryKey: ["agent-pref", KEY, userId] });
      toast.success(
        mode === "expanded"
          ? "Briefs will match documents on activity + participants + severity"
          : "Briefs will match documents on the activity keyword only",
      );
    },
    onError: (e) => {
      setLocal(current);
      toast.error((e as Error).message);
    },
  });

  return (
    <div className="flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-2">
      <div className="min-w-0 flex-1">
        <Label htmlFor="brief-match-toggle" className="text-sm font-medium">
          Brief quality: expanded document match
        </Label>
        <p className="text-[11px] text-muted-foreground">
          Off = keyword only (faster, tighter). On = also match participant
          names + severity for broader recall.
        </p>
      </div>
      <Switch
        id="brief-match-toggle"
        checked={local === "expanded"}
        disabled={save.isPending || !userId}
        onCheckedChange={(v) => {
          const next: BriefMatchMode = v ? "expanded" : "keyword";
          setLocal(next);
          save.mutate(next);
        }}
      />
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useIsAdmin } from "@/hooks/useSession";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Trash2, Plus } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/holidays")({
  head: () => ({ meta: [{ title: "Holidays — DelayLens" }] }),
  component: HolidaysPage,
});

type Holiday = { id: string; holiday_date: string; label: string | null };

function HolidaysPage() {
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const [date, setDate] = useState("");
  const [label, setLabel] = useState("");

  const { data } = useQuery({
    queryKey: ["holidays"],
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase.from("holidays").select("*").order("holiday_date");
      if (error) throw error;
      return data as Holiday[];
    },
  });

  const add = useMutation({
    mutationFn: async () => {
      if (!date) throw new Error("Pick a date");
      const { error } = await supabase.from("holidays").insert({ holiday_date: date, label: label || null });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["holidays"] }); setDate(""); setLabel(""); toast.success("Added"); },
    onError: (e) => toast.error((e as Error).message),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("holidays").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["holidays"] }),
  });

  if (!isAdmin) return <div className="mx-auto max-w-3xl px-4 py-8 text-muted-foreground">Admins only.</div>;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Holidays</h1>
      <p className="mt-1 text-sm text-muted-foreground">Used for business-day TAT calculations.</p>
      <Card className="mt-6 p-4">
        <div className="flex gap-2">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
          <Input placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Button onClick={() => add.mutate()}><Plus className="mr-1.5 h-4 w-4" />Add</Button>
        </div>
      </Card>
      <Card className="mt-4 divide-y divide-border/60">
        {data?.length === 0 && <p className="p-6 text-sm text-muted-foreground">No holidays defined.</p>}
        {data?.map((h) => (
          <div key={h.id} className="flex items-center gap-4 p-3 text-sm">
            <div className="w-32 font-mono">{h.holiday_date}</div>
            <div className="flex-1">{h.label ?? <span className="text-muted-foreground">—</span>}</div>
            <Button variant="ghost" size="icon" onClick={() => del.mutate(h.id)}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
      </Card>
    </div>
  );
}

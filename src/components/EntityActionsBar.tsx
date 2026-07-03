// EntityActionsBar — 4 one-click actions available on every entity detail
// page (person / stage / project). All state changes route through existing
// server functions and RLS: sendAlert (email), sendDirectMessage (message /
// task), raiseConcern (concern).

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Mail, MessageSquare, ListTodo, Flag, Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { RaiseConcernDialog } from "@/components/RaiseConcernDialog";
import { sendAlert } from "@/lib/alerts.functions";
import {
  sendDirectMessage, listDirectory, type DirectoryUser,
} from "@/lib/messages.functions";

export type EntityActionContext = {
  scopeLabel: string;         // "Ashish Kumar" · "Pre-Execution" · "PSPCL Kharar"
  scopeKind: "person" | "stage" | "project";
  scopeRef?: string;          // key used in URLs, for message threading
  responsibleName?: string | null;
  responsibleEmail?: string | null;
  defaultDept?: string | null;
  summaryLine?: string;       // one-line context injected into every draft
};

export function EntityActionsBar({ ctx }: { ctx: EntityActionContext }) {
  const [openMessage, setOpenMessage] = useState(false);
  const [openEmail, setOpenEmail] = useState(false);
  const [openTask, setOpenTask] = useState(false);
  const [openConcern, setOpenConcern] = useState(false);

  return (
    <>
      <div className="flex flex-wrap gap-2" role="toolbar" aria-label="Entity actions">
        <Button size="sm" onClick={() => setOpenMessage(true)}>
          <MessageSquare className="h-4 w-4" /> Send message
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setOpenEmail(true)}>
          <Mail className="h-4 w-4" /> Draft email
        </Button>
        <Button size="sm" variant="outline" onClick={() => setOpenTask(true)}>
          <ListTodo className="h-4 w-4" /> Create task
        </Button>
        <Button size="sm" variant="outline" onClick={() => setOpenConcern(true)}>
          <Flag className="h-4 w-4" /> Raise concern
        </Button>
      </div>

      <MessageDialog open={openMessage} onOpenChange={setOpenMessage} ctx={ctx} />
      <EmailDialog   open={openEmail}   onOpenChange={setOpenEmail}   ctx={ctx} />
      <TaskDialog    open={openTask}    onOpenChange={setOpenTask}    ctx={ctx} />
      <RaiseConcernDialog
        open={openConcern}
        onOpenChange={setOpenConcern}
        defaultActivity={ctx.scopeLabel}
        defaultTargetDept={ctx.defaultDept ?? undefined}
        ownerEmail={ctx.responsibleEmail ?? undefined}
      />
    </>
  );
}

// ── Send internal message ───────────────────────────────────────────────

function MessageDialog({ open, onOpenChange, ctx }: {
  open: boolean; onOpenChange: (o: boolean) => void; ctx: EntityActionContext;
}) {
  const listDirFn = useServerFn(listDirectory);
  const sendFn = useServerFn(sendDirectMessage);
  const [recipient, setRecipient] = useState<string>("");
  const [subject, setSubject] = useState(`Re: ${ctx.scopeLabel}`);
  const [body, setBody] = useState(defaultBody(ctx));

  const dirQ = useQuery({
    queryKey: ["directory"],
    queryFn: () => listDirFn(),
    enabled: open,
  });

  const mut = useMutation({
    mutationFn: async () => sendFn({ data: {
      recipient_id: recipient,
      subject: subject.trim() || null as unknown as string | undefined,
      body,
      context_kind: ctx.scopeKind,
      context_ref: ctx.scopeRef,
    }}),
    onSuccess: () => { toast.success("Message sent"); onOpenChange(false); },
    onError: (e) => toast.error((e as Error).message),
  });

  // Preselect the responsible person when their profile is in the directory.
  const users: DirectoryUser[] = dirQ.data?.users ?? [];
  const suggestedId = users.find((u) =>
    ctx.responsibleEmail && u.email?.toLowerCase() === ctx.responsibleEmail.toLowerCase(),
  )?.id;
  if (suggestedId && !recipient) setRecipient(suggestedId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Send internal message</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Recipient</Label>
            <Select value={recipient} onValueChange={setRecipient}>
              <SelectTrigger><SelectValue placeholder={dirQ.isLoading ? "Loading…" : "Select a colleague"} /></SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.full_name || u.email} {u.department ? `· ${u.department}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Subject</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Message</Label>
            <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || !recipient || !body.trim()}>
            {mut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Draft & send email via sendAlert ────────────────────────────────────

function EmailDialog({ open, onOpenChange, ctx }: {
  open: boolean; onOpenChange: (o: boolean) => void; ctx: EntityActionContext;
}) {
  const sendFn = useServerFn(sendAlert);
  const [to, setTo] = useState(ctx.responsibleEmail ?? "");
  const [subject, setSubject] = useState(`Action needed: ${ctx.scopeLabel}`);
  const [body, setBody] = useState(defaultBody(ctx));

  const mut = useMutation({
    mutationFn: async () => sendFn({ data: { flag: {
      id: `entity-${ctx.scopeKind}-${Date.now()}`,
      activity: ctx.scopeLabel.slice(0, 500),
      stage: ctx.scopeKind === "stage" ? ctx.scopeLabel.slice(0, 200) : null,
      severity: "med",
      source: `Entity · ${ctx.scopeKind}`,
      root_cause: subject.slice(0, 2000),
      reason: body.slice(0, 2000),
      responsible_email: (to || ctx.responsibleEmail || null),
      responsible_name: ctx.responsibleName ?? null,
      extra_recipients: [],
    }}}),
    onSuccess: () => { toast.success("Email dispatched"); onOpenChange(false); },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Draft &amp; send email</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>To</Label>
            <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" />
          </div>
          <div className="space-y-1.5">
            <Label>Subject</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Body</Label>
            <Textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || !to.trim() || !body.trim()}>
            {mut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
            Send email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Create follow-up task (self-directed message tagged as task) ────────

function TaskDialog({ open, onOpenChange, ctx }: {
  open: boolean; onOpenChange: (o: boolean) => void; ctx: EntityActionContext;
}) {
  const listDirFn = useServerFn(listDirectory);
  const sendFn = useServerFn(sendDirectMessage);
  const [assignee, setAssignee] = useState<string>("__me__");
  const [title, setTitle] = useState(`Follow up: ${ctx.scopeLabel}`);
  const [due, setDue] = useState<string>(() => {
    const d = new Date(); d.setDate(d.getDate() + 3);
    return d.toISOString().slice(0, 10);
  });
  const [notes, setNotes] = useState(defaultBody(ctx));

  const dirQ = useQuery({ queryKey: ["directory"], queryFn: () => listDirFn(), enabled: open });
  const users: DirectoryUser[] = dirQ.data?.users ?? [];

  const mut = useMutation({
    mutationFn: async () => {
      // Tasks are stored as direct messages with kind=task so they show up
      // in the recipient's inbox and activities feed with no schema change.
      const body = [
        `📌 Task · due ${due}`,
        "",
        notes,
        "",
        `— Context: ${ctx.scopeLabel}`,
      ].join("\n");
      const recipient_id = assignee === "__me__" ? "" : assignee;
      if (!recipient_id) {
        // Self-task: use the current user as recipient. sendDirectMessage
        // rejects self-messages, so we instead surface a toast + copy to clipboard.
        await navigator.clipboard?.writeText(`${title}\n${body}`).catch(() => {});
        toast.success("Personal task copied — paste into your notes");
        onOpenChange(false);
        return;
      }
      await sendFn({ data: {
        recipient_id, subject: title, body, context_kind: "task", context_ref: ctx.scopeRef,
      }});
    },
    onSuccess: () => { toast.success("Task created"); onOpenChange(false); },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Create follow-up task</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Assign to</Label>
            <Select value={assignee} onValueChange={setAssignee}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__me__">Myself (copy to clipboard)</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.full_name || u.email}{u.department ? ` · ${u.department}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Due date</Label>
              <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || !title.trim()}>
            {mut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListTodo className="h-4 w-4" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function defaultBody(ctx: EntityActionContext) {
  const salutation = ctx.responsibleName ? `Hi ${ctx.responsibleName.split(" ")[0]},` : "Hi,";
  return [
    salutation,
    "",
    `Following up on ${ctx.scopeLabel}.`,
    ctx.summaryLine ? "" : "",
    ctx.summaryLine ?? "",
    "",
    "Could you share the current status, the top blocker, and a committed recovery date?",
    "",
    "Thanks.",
  ].filter((s, i, arr) => !(s === "" && arr[i - 1] === "")).join("\n");
}

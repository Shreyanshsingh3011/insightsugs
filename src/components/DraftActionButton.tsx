// One-shot "Queue a draft" button — writes to agent_drafts so the action
// lands in /agent/inbox for review + 1-click approval, rather than firing
// immediately. Complements EntityActionsBar (which sends directly).

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Sparkles, Send, Loader2 } from "lucide-react";
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
import { createAgentDraft } from "@/lib/agent-inbox.functions";

type Props = {
  sourceKind: string;              // e.g. "row.person" | "row.stage" | "row.overdue"
  sourceKey: string;               // stable identifier within source_kind
  scopeLabel: string;              // human title, e.g. "Ashish Kumar — 4 overdue tasks"
  recipientEmail?: string | null;
  recipientName?: string | null;
  contextSummary?: string;         // one-liner injected into the body
  size?: "sm" | "default";
  variant?: "default" | "outline" | "secondary";
};

export function DraftActionButton(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size={props.size ?? "sm"}
        variant={props.variant ?? "outline"}
        onClick={() => setOpen(true)}
      >
        <Sparkles className="h-4 w-4" /> Draft an action
      </Button>
      {open && <DraftDialog {...props} open={open} onOpenChange={setOpen} />}
    </>
  );
}

function DraftDialog(props: Props & { open: boolean; onOpenChange: (o: boolean) => void }) {
  const createFn = useServerFn(createAgentDraft);

  const firstName = props.recipientName?.split(/\s+/)[0] || "";
  const defaultSubject = `Follow up: ${props.scopeLabel}`.slice(0, 200);
  const defaultBody = [
    firstName ? `Hi ${firstName},` : "Hi,",
    "",
    props.contextSummary || `Following up on ${props.scopeLabel}.`,
    "",
    "Could you share the latest status, the top blocker, and a committed recovery date?",
    "",
    "Thanks.",
  ].join("\n");

  const [draftType, setDraftType] = useState<"nudge" | "escalation" | "root_cause_ask" | "status_update">("nudge");
  const [channel, setChannel] = useState<"direct_message" | "email">(
    props.recipientEmail ? "direct_message" : "direct_message",
  );
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(defaultBody);
  const [recipient, setRecipient] = useState(props.recipientEmail ?? "");

  const mut = useMutation({
    mutationFn: async () => createFn({ data: {
      draft_type: draftType,
      source_kind: props.sourceKind,
      source_key: props.sourceKey,
      title: props.scopeLabel.slice(0, 400),
      subject,
      body,
      channel,
      recipient_email: channel === "email" ? (recipient || null) : (recipient || null),
      confidence: 0.75,
      why: `Manually drafted from ${props.sourceKind}: ${props.scopeLabel}`,
      payload: { source_kind: props.sourceKind, source_key: props.sourceKey, scope_label: props.scopeLabel },
    }}),
    onSuccess: (r) => {
      toast.success(r.deduped ? "A pending draft already exists — reused it." : "Draft queued to Agent Inbox.");
      props.onOpenChange(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> Draft an action
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={draftType} onValueChange={(v) => setDraftType(v as typeof draftType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="nudge">Nudge</SelectItem>
                  <SelectItem value="escalation">Escalation</SelectItem>
                  <SelectItem value="root_cause_ask">Root-cause ask</SelectItem>
                  <SelectItem value="status_update">Status update</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Channel</Label>
              <Select value={channel} onValueChange={(v) => setChannel(v as typeof channel)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="direct_message">In-app message</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Recipient email</Label>
            <Input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="name@example.com"
            />
            <p className="text-[11px] text-muted-foreground">
              If a matching user exists, the draft is assigned to them for approval; otherwise it goes to an admin queue.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Subject</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Body</Label>
            <Textarea rows={7} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || !body.trim() || !subject.trim()}>
            {mut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Queue draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

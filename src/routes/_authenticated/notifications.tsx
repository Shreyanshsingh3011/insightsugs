import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/hooks/useSession";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckCheck, Inbox, MailPlus, Search, Send } from "lucide-react";
import { toast } from "sonner";
import {
  listInbox, listSent, listDirectory,
  sendDirectMessage, markMessageRead, markAllInboxRead,
  type DirectMessage, type DirectoryUser,
} from "@/lib/messages.functions";
import { approveSignupFn, rejectSignupFn } from "@/lib/signup-verify.functions";

export const Route = createFileRoute("/_authenticated/notifications")({
  head: () => ({ meta: [{ title: "Inbox — DelayLens" }] }),
  component: InboxPage,
});

type N = { id: string; kind: string; title: string; body: string | null; created_at: string; read_at: string | null };

function fmtWhen(iso: string) {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleString();
}

function InboxPage() {
  const { userId } = useSession();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"messages" | "sent" | "system">("messages");
  const [composeOpen, setComposeOpen] = useState(false);
  const [q, setQ] = useState("");

  // System notifications
  const notifQ = useQuery({
    queryKey: ["notifications", userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notifications").select("*").eq("user_id", userId!)
        .order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return data as N[];
    },
  });

  const markAllNotif = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("user_id", userId!).is("read_at", null);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  // Messages
  const inboxFn = useServerFn(listInbox);
  const sentFn = useServerFn(listSent);
  const inboxQ = useQuery({
    queryKey: ["inbox-messages"],
    queryFn: () => inboxFn(),
  });
  const sentQ = useQuery({
    queryKey: ["inbox-sent"],
    queryFn: () => sentFn(),
  });

  const markAllMsg = useMutation({
    mutationFn: useServerFn(markAllInboxRead),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inbox-messages"] }),
  });

  const unreadCount = (inboxQ.data?.messages ?? []).filter((m) => !m.read_at).length;
  const unreadNotif = (notifQ.data ?? []).filter((n) => !n.read_at).length;

  const currentMessages = useMemo(() => {
    const rows = tab === "sent" ? sentQ.data?.messages ?? [] : inboxQ.data?.messages ?? [];
    if (!q.trim()) return rows;
    const needle = q.toLowerCase();
    return rows.filter((m) => {
      const person = tab === "sent" ? m.recipient : m.sender;
      const hay = `${m.subject ?? ""} ${m.body} ${person?.full_name ?? ""} ${person?.email ?? ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [tab, q, inboxQ.data, sentQ.data]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Inbox className="h-6 w-6" aria-hidden /> Inbox
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Messages from colleagues and system notifications.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="default" size="sm" onClick={() => setComposeOpen(true)}>
            <MailPlus className="mr-1.5 h-4 w-4" /> New message
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as any)} className="mt-6">
        <div className="flex flex-wrap items-center gap-2">
          <TabsList>
            <TabsTrigger value="messages" className="gap-2">
              Messages {unreadCount > 0 && <Badge variant="destructive" className="h-5 px-1.5">{unreadCount}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="sent">Sent</TabsTrigger>
            <TabsTrigger value="system" className="gap-2">
              System {unreadNotif > 0 && <Badge variant="secondary" className="h-5 px-1.5">{unreadNotif}</Badge>}
            </TabsTrigger>
          </TabsList>
          {tab !== "system" && (
            <div className="relative ml-auto">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search messages…"
                className="h-9 w-64 pl-8"
                aria-label="Search messages"
              />
            </div>
          )}
          {tab === "messages" && unreadCount > 0 && (
            <Button variant="outline" size="sm" onClick={() => markAllMsg.mutate(undefined)}>
              <CheckCheck className="mr-1.5 h-4 w-4" /> Mark all read
            </Button>
          )}
          {tab === "system" && unreadNotif > 0 && (
            <Button variant="outline" size="sm" onClick={() => markAllNotif.mutate()} className="ml-auto">
              <CheckCheck className="mr-1.5 h-4 w-4" /> Mark all read
            </Button>
          )}
        </div>

        <TabsContent value="messages" className="mt-4">
          <MessageList
            messages={currentMessages}
            emptyText="No messages. Start a conversation with a colleague."
            perspective="inbox"
          />
        </TabsContent>
        <TabsContent value="sent" className="mt-4">
          <MessageList
            messages={currentMessages}
            emptyText="You haven't sent any messages yet."
            perspective="sent"
          />
        </TabsContent>
        <TabsContent value="system" className="mt-4">
          <Card className="divide-y divide-border/60">
            {(notifQ.data?.length ?? 0) === 0 && (
              <p className="p-8 text-center text-sm text-muted-foreground">You're all caught up.</p>
            )}
            {notifQ.data?.map((n) => (
              <div key={n.id} className={`p-4 ${n.read_at ? "opacity-60" : ""}`}>
                <div className="flex items-center gap-2">
                  <Badge variant={n.read_at ? "outline" : "default"}>{n.kind}</Badge>
                  <span className="font-medium">{n.title}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{fmtWhen(n.created_at)}</span>
                </div>
                {n.body && <p className="mt-1 text-sm text-muted-foreground whitespace-pre-wrap">{n.body}</p>}
                {n.kind === "signup_pending_review" && (
                  <SignupNotificationActions body={n.body ?? ""} notificationId={n.id} />
                )}
              </div>
            ))}
          </Card>
        </TabsContent>
      </Tabs>

      <ComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        onSent={() => {
          qc.invalidateQueries({ queryKey: ["inbox-sent"] });
          qc.invalidateQueries({ queryKey: ["inbox-messages"] });
        }}
      />
    </div>
  );
}

function MessageList({
  messages, emptyText, perspective,
}: {
  messages: DirectMessage[];
  emptyText: string;
  perspective: "inbox" | "sent";
}) {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<DirectMessage | null>(null);
  const markRead = useMutation({
    mutationFn: useServerFn(markMessageRead),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inbox-messages"] }),
  });

  const open = messages.find((m) => m.id === openId) ?? null;

  if (messages.length === 0) {
    return (
      <Card className="p-10 text-center text-sm text-muted-foreground">{emptyText}</Card>
    );
  }

  return (
    <>
      <Card className="divide-y divide-border/60">
        {messages.map((m) => {
          const person = perspective === "sent" ? m.recipient : m.sender;
          const unread = perspective === "inbox" && !m.read_at;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                setOpenId(m.id);
                if (unread) markRead.mutate({ data: { id: m.id } });
              }}
              className={`flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-accent/40 focus:outline-none focus:ring-2 focus:ring-ring ${unread ? "" : "opacity-80"}`}
            >
              <div className={`mt-1 h-2 w-2 shrink-0 rounded-full ${unread ? "bg-primary" : "bg-transparent"}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`truncate text-sm ${unread ? "font-semibold" : "font-medium"}`}>
                    {perspective === "sent" ? "To " : ""}{person?.full_name || person?.email || "Unknown"}
                  </span>
                  {m.context_kind && (
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px] uppercase">{m.context_kind}</Badge>
                  )}
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{fmtWhen(m.created_at)}</span>
                </div>
                {m.subject && <p className="mt-0.5 truncate text-sm font-medium">{m.subject}</p>}
                <p className="mt-1 truncate text-sm text-muted-foreground">{m.body}</p>
              </div>
            </button>
          );
        })}
      </Card>

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpenId(null)}>
        <DialogContent className="max-w-lg">
          {open && (
            <>
              <DialogHeader>
                <DialogTitle>{open.subject || "(no subject)"}</DialogTitle>
                <DialogDescription>
                  {perspective === "sent"
                    ? `To ${open.recipient?.full_name || open.recipient?.email}`
                    : `From ${open.sender?.full_name || open.sender?.email}`}
                  {" · "}{new Date(open.created_at).toLocaleString()}
                </DialogDescription>
              </DialogHeader>
              <div className="whitespace-pre-wrap text-sm">{open.body}</div>
              <DialogFooter>
                {perspective === "inbox" && (
                  <Button variant="outline" size="sm" onClick={() => { setReplyTo(open); setOpenId(null); }}>
                    <Send className="mr-1.5 h-4 w-4" /> Reply
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => setOpenId(null)}>Close</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ComposeDialog
        open={!!replyTo}
        onOpenChange={(o) => !o && setReplyTo(null)}
        prefill={replyTo ? {
          recipient_id: replyTo.sender_id,
          recipient_label: replyTo.sender?.full_name || replyTo.sender?.email || "",
          subject: replyTo.subject ? (replyTo.subject.startsWith("Re:") ? replyTo.subject : `Re: ${replyTo.subject}`) : "",
          body: `\n\n---\n${replyTo.body}`,
        } : undefined}
        onSent={() => {
          setReplyTo(null);
          qc.invalidateQueries({ queryKey: ["inbox-sent"] });
        }}
      />
    </>
  );
}

function ComposeDialog({
  open, onOpenChange, onSent, prefill,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSent: () => void;
  prefill?: { recipient_id: string; recipient_label: string; subject?: string; body?: string };
}) {
  const dirFn = useServerFn(listDirectory);
  const dirQ = useQuery({
    queryKey: ["message-directory"],
    queryFn: () => dirFn(),
    enabled: open,
  });
  const users: DirectoryUser[] = dirQ.data?.users ?? [];

  const [recipient, setRecipient] = useState<string>("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [search, setSearch] = useState("");

  // Reset when opened
  useMemo(() => {
    if (open) {
      setRecipient(prefill?.recipient_id ?? "");
      setSubject(prefill?.subject ?? "");
      setBody(prefill?.body ?? "");
      setSearch("");
    }
  }, [open, prefill?.recipient_id]);

  const filteredUsers = useMemo(() => {
    if (!search.trim()) return users.slice(0, 50);
    const n = search.toLowerCase();
    return users.filter((u) =>
      (u.full_name ?? "").toLowerCase().includes(n) ||
      (u.email ?? "").toLowerCase().includes(n) ||
      (u.department ?? "").toLowerCase().includes(n)
    ).slice(0, 50);
  }, [users, search]);

  const sendMut = useMutation({
    mutationFn: useServerFn(sendDirectMessage),
    onSuccess: () => {
      toast.success("Message sent");
      onSent();
      onOpenChange(false);
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to send"),
  });

  const submit = () => {
    if (!recipient) return toast.error("Choose a recipient");
    if (!body.trim()) return toast.error("Write a message");
    sendMut.mutate({ data: { recipient_id: recipient, subject, body } });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New message</DialogTitle>
          <DialogDescription>Send an internal message to a colleague.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {prefill?.recipient_label ? (
            <div className="text-sm">
              <span className="text-muted-foreground">To: </span>
              <span className="font-medium">{prefill.recipient_label}</span>
            </div>
          ) : (
            <>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search people by name, email, department…"
                aria-label="Search recipients"
              />
              <Select value={recipient} onValueChange={setRecipient}>
                <SelectTrigger aria-label="Recipient">
                  <SelectValue placeholder={dirQ.isLoading ? "Loading users…" : "Choose a recipient"} />
                </SelectTrigger>
                <SelectContent>
                  {filteredUsers.length === 0 && (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">No matches</div>
                  )}
                  {filteredUsers.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.full_name || u.email}
                      {u.department ? ` · ${u.department}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject (optional)"
            aria-label="Subject"
          />
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your message…"
            rows={6}
            maxLength={4000}
            aria-label="Message body"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={sendMut.isPending}>
            <Send className="mr-1.5 h-4 w-4" />
            {sendMut.isPending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SignupNotificationActions({ body, notificationId }: { body: string; notificationId: string }) {
  const qc = useQueryClient();
  const approveFn = useServerFn(approveSignupFn);
  const rejectFn = useServerFn(rejectSignupFn);
  const [busy, setBusy] = useState<"approve" | "dismiss" | null>(null);

  const emailMatch = body.match(/<([^>\s]+@[^>\s]+)>/);
  const email = emailMatch?.[1]?.toLowerCase() ?? null;
  const roleMatch = body.match(/^(super_admin|admin|user)\b/i);
  const requestedRole = (roleMatch?.[1]?.toLowerCase() as "super_admin" | "admin" | "user" | undefined) ?? "user";

  const reqQ = useQuery({
    queryKey: ["signup-request-by-email", email],
    enabled: !!email,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signup_requests")
        .select("id, status, requested_role, email")
        .ilike("email", email!)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const markNotifRead = async () => {
    await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", notificationId);
    qc.invalidateQueries({ queryKey: ["notifications"] });
  };

  const onDone = () => {
    qc.invalidateQueries({ queryKey: ["signup-request-by-email", email] });
    qc.invalidateQueries({ queryKey: ["signup-requests"] });
    qc.invalidateQueries({ queryKey: ["pending-signups-count"] });
  };

  const approve = async () => {
    if (!reqQ.data?.id) return toast.error("Request not found");
    setBusy("approve");
    try {
      const role = (reqQ.data.requested_role as any) ?? requestedRole;
      await approveFn({ data: { requestId: reqQ.data.id, role } });
      await markNotifRead();
      toast.success("Signup approved");
      onDone();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to approve");
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async () => {
    if (!reqQ.data?.id) return toast.error("Request not found");
    setBusy("dismiss");
    try {
      await rejectFn({ data: { requestId: reqQ.data.id, reason: "Dismissed from inbox" } });
      await markNotifRead();
      toast.success("Signup dismissed");
      onDone();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to dismiss");
    } finally {
      setBusy(null);
    }
  };

  if (!email) return null;

  const status = reqQ.data?.status;
  if (status && status !== "pending") {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline" className="uppercase">{status}</Badge>
        <span>Already resolved</span>
      </div>
    );
  }

  return (
    <div className="mt-3 flex items-center gap-2">
      <Button
        size="sm"
        onClick={approve}
        disabled={busy !== null || reqQ.isLoading || !reqQ.data}
      >
        {busy === "approve" ? "Approving…" : "Approve"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={dismiss}
        disabled={busy !== null || reqQ.isLoading || !reqQ.data}
      >
        {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
      </Button>
      {reqQ.isLoading && <span className="text-xs text-muted-foreground">Loading…</span>}
      {!reqQ.isLoading && !reqQ.data && (
        <span className="text-xs text-muted-foreground">No matching pending request</span>
      )}
    </div>
  );
}

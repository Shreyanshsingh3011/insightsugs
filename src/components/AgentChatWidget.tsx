// Floating agentic chat widget for the Agent Dashboard.
// Uses AI SDK useChat + AI Elements. Streams from /api/chat with a
// compact snapshot of the current project context.
import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Bot, MessageCircle, X, Sparkles, ThumbsUp, ThumbsDown, ShieldCheck } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { submitAgentRunFeedback } from "@/lib/agent-runs.functions";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputSubmit,
  PromptInputBody,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { cn } from "@/lib/utils";

export type AgentChatContext = {
  projectId?: string;
  projectLabel?: string;
  rows?: Array<Record<string, unknown>>;
  personRanking?: unknown[];
  tatRows?: unknown[];
  flags?: unknown[];
  totals?: Record<string, number>;
  riskScore?: number;
};

const SUGGESTIONS = [
  "Who has the most overdue items right now?",
  "Show me the top 5 delays.",
  "What critical alerts are open?",
  "Give me a project summary.",
];

export default function AgentChatWidget({
  context,
  actorId,
}: {
  context: AgentChatContext;
  actorId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");

  const contextRef = useRef(context);
  useEffect(() => {
    contextRef.current = context;
  }, [context]);

  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [feedbackGiven, setFeedbackGiven] = useState<Record<string, 1 | -1>>({});
  const feedbackMut = useServerFn(submitAgentRunFeedback);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages, id, body }) => ({
          body: {
            ...body,
            id,
            messages,
            context: contextRef.current,
            actorId: actorId ?? null,
          },
        }),
        fetch: async (url, init) => {
          const resp = await fetch(url, init);
          const rid = resp.headers.get("x-agent-run-id");
          if (rid) setLastRunId(rid);
          return resp;
        },
      }),
    [actorId],
  );

  const chatId = `agent-${context.projectId ?? "default"}`;
  const { messages, sendMessage, status, error, stop } = useChat({
    id: chatId,
    transport,
  });

  const isBusy = status === "submitted" || status === "streaming";

  // Keyboard: Cmd/Ctrl + K opens the widget.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape" && open) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Focus textarea on open.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) setTimeout(() => textareaRef.current?.focus(), 100);
  }, [open, messages.length]);

  const submit = (text: string) => {
    const value = text.trim();
    if (!value || isBusy) return;
    sendMessage({ text: value });
    setInput("");
  };

  return (
    <div className="fixed bottom-6 right-6 z-50 print:hidden">
      {open ? (
        <div
          role="dialog"
          aria-label="DelayLens Copilot"
          className={cn(
            "flex h-[min(640px,80vh)] w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl",
            "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-4 duration-200",
            "sm:w-[420px]",
          )}
        >
          <header className="flex items-center gap-2 border-b bg-gradient-to-r from-primary/10 to-transparent px-4 py-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-primary">
              <Bot className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold leading-tight">DelayLens Copilot</div>
              <div className="text-[11px] text-muted-foreground truncate">
                {context.projectLabel ?? context.projectId ?? "No project selected"} · grounded in dashboard data
              </div>
            </div>
            <Link
              to="/agent/approvals"
              className="text-[11px] text-primary hover:underline flex items-center gap-1"
              title="Review actions the copilot proposed"
            >
              <ShieldCheck className="h-3 w-3" /> Approvals
            </Link>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setOpen(false)}
              aria-label="Close chat"
            >
              <X className="h-4 w-4" />
            </Button>
          </header>

          <Conversation className="flex-1">
            <ConversationContent className="space-y-4 px-4 py-3">
              {messages.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Sparkles className="h-5 w-5" />
                  </div>
                  <div className="text-sm font-medium">Ask about this project</div>
                  <p className="text-xs text-muted-foreground max-w-[280px]">
                    I answer only from the current dashboard data. Try one:
                  </p>
                  <div className="mt-2 flex flex-wrap justify-center gap-1.5">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => submit(s)}
                        className="rounded-full border bg-muted/40 px-3 py-1 text-xs hover:bg-muted transition-colors"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {messages.map((m) => (
                <Message key={m.id} from={m.role}>
                  <MessageContent
                    className={cn(
                      m.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-transparent p-0 shadow-none",
                    )}
                  >
                    {m.parts.map((part, i) => {
                      if (part.type === "text") {
                        return m.role === "assistant" ? (
                          <MessageResponse key={i}>{part.text}</MessageResponse>
                        ) : (
                          <span key={i}>{part.text}</span>
                        );
                      }
                      if (part.type.startsWith("tool-")) {
                        const p = part as {
                          type: string;
                          toolCallId?: string;
                          state?: string;
                          input?: unknown;
                          output?: unknown;
                          errorText?: string;
                        };
                        const name = part.type.slice("tool-".length);
                        const state =
                          (p.state as
                            | "input-streaming"
                            | "input-available"
                            | "output-available"
                            | "output-error") ?? "input-streaming";
                        return (
                          <Tool key={p.toolCallId ?? i} defaultOpen={false}>
                            <ToolHeader type={`tool-${name}` as `tool-${string}`} state={state} />
                            <ToolContent>
                              {p.input !== undefined ? <ToolInput input={p.input} /> : null}
                              {(p.output !== undefined || p.errorText) && (
                                <ToolOutput
                                  output={
                                    p.output !== undefined ? (
                                      <pre className="whitespace-pre-wrap text-xs">
                                        {typeof p.output === "string"
                                          ? p.output
                                          : JSON.stringify(p.output, null, 2)}
                                      </pre>
                                    ) : null
                                  }
                                  errorText={p.errorText}
                                />
                              )}
                            </ToolContent>
                          </Tool>
                        );
                      }
                      return null;
                    })}
                  </MessageContent>
                </Message>
              ))}

              {status === "submitted" ? (
                <div className="px-1 py-2">
                  <Shimmer>Thinking…</Shimmer>
                </div>
              ) : null}

              {error ? (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
                >
                  <div className="font-medium">Something went wrong</div>
                  <div className="opacity-80">{error.message}</div>
                </div>
              ) : null}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          <div className="border-t p-3">
            <PromptInput
              onSubmit={(message, e) => {
                e.preventDefault();
                if (isBusy) {
                  stop();
                  return;
                }
                submit(message.text || input);
              }}
            >
              <PromptInputBody>
                <PromptInputTextarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Ask about delays, people, alerts…"
                  disabled={isBusy && status === "streaming" ? false : false}
                />
              </PromptInputBody>
              <div className="flex items-center justify-between gap-2 pt-2">
                <span className="text-[10px] text-muted-foreground">
                  ⌘K to toggle · Enter to send
                </span>
                <PromptInputSubmit status={status} disabled={!input.trim() && !isBusy} />
              </div>
            </PromptInput>
          </div>
        </div>
      ) : (
        <Button
          size="icon"
          onClick={() => setOpen(true)}
          aria-label="Open DelayLens Copilot"
          className="h-14 w-14 rounded-full shadow-lg shadow-primary/30 hover:scale-105 transition-transform"
        >
          <MessageCircle className="h-6 w-6" />
        </Button>
      )}
    </div>
  );
}

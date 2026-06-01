'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import {
  listConversationsAction,
  createConversationAction,
  deleteConversationAction,
  listChatAction,
  sendChatMessageAction,
  getChatJobStatusAction,
  type ConversationView,
  type ChatMessageView,
  type ChatJobStatus,
} from '@/lib/actions.ts';

const TERMINAL_JOB = new Set(['completed', 'failed', 'cancelled']);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function relativeTime(date: Date | null): string {
  if (!date) return '';
  const now = Date.now();
  const diff = now - date.getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

type DateGroup = 'TODAY' | 'YESTERDAY' | 'EARLIER';

function dateGroup(date: Date | null): DateGroup {
  if (!date) return 'EARLIER';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (d.getTime() === today.getTime()) return 'TODAY';
  if (d.getTime() === yesterday.getTime()) return 'YESTERDAY';
  return 'EARLIER';
}

function groupConversations(
  convos: ConversationView[],
): { group: DateGroup; items: ConversationView[] }[] {
  const buckets: Record<DateGroup, ConversationView[]> = {
    TODAY: [],
    YESTERDAY: [],
    EARLIER: [],
  };
  for (const c of convos) buckets[dateGroup(c.updatedAt)].push(c);
  const order: DateGroup[] = ['TODAY', 'YESTERDAY', 'EARLIER'];
  return order.filter((g) => buckets[g].length > 0).map((g) => ({ group: g, items: buckets[g] }));
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  initialConversations: ConversationView[];
  rootName: string | null;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ChatClient({ initialConversations, rootName }: Props) {
  const [conversations, setConversations] = useState<ConversationView[]>(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(initialConversations[0]?.id ?? null);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [search, setSearch] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  // A reply is in flight whenever the latest persisted message is a user turn.
  const lastIsUser = messages.length > 0 && messages[messages.length - 1]!.role === 'user';

  // ── Scroll to bottom whenever messages change ──────────────────────────────
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, lastIsUser]);

  // ── Refresh conversations list ─────────────────────────────────────────────
  const refreshConversations = useCallback(async () => {
    const r = await listConversationsAction();
    if (r.ok) setConversations(r.data.conversations);
  }, []);

  // ── Load a conversation's thread ──────────────────────────────────────────
  const loadThread = useCallback(async (id: string) => {
    setLoadingThread(true);
    const r = await listChatAction(id);
    setLoadingThread(false);
    if (r.ok) setMessages(r.data.messages);
  }, []);

  // ── On mount: load the first conversation's thread ─────────────────────────
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (activeId) void loadThread(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Polling: while a reply is in flight, poll until it lands ──────────────
  useEffect(() => {
    if (!lastIsUser || !activeId) return;
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      if (cancelled || tries >= 30) return;
      tries += 1;
      const r = await listChatAction(activeId);
      if (cancelled || !r.ok) return;
      setMessages(r.data.messages);
      const stillPending = r.data.messages[r.data.messages.length - 1]?.role === 'user';
      if (stillPending) {
        timer = setTimeout(() => void poll(), 2000);
      } else {
        // Reply landed — refresh sidebar so title/recency updates
        void refreshConversations();
      }
    };

    timer = setTimeout(() => void poll(), 2000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [lastIsUser, activeId, refreshConversations]);

  // ── Select a conversation ──────────────────────────────────────────────────
  async function selectConversation(id: string) {
    if (id === activeId) return;
    setActiveId(id);
    setMessages([]);
    await loadThread(id);
  }

  // ── Create a new conversation ──────────────────────────────────────────────
  async function handleNew() {
    const r = await createConversationAction();
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    await refreshConversations();
    setMessages([]);
    setActiveId(r.data.id);
  }

  // ── Delete a conversation ──────────────────────────────────────────────────
  async function handleDelete(id: string) {
    const r = await deleteConversationAction(id);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }
    const updated = conversations.filter((c) => c.id !== id);
    setConversations(updated);
    if (activeId === id) {
      const next = updated[0]?.id ?? null;
      setActiveId(next);
      if (next) {
        await loadThread(next);
      } else {
        setMessages([]);
      }
    }
    toast.success('Conversation deleted');
  }

  // ── Send a message ─────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const message = input.trim();
    if (!message || sending) return;

    setInput('');
    setSending(true);

    // No active conversation (fresh /chat) → create one on the fly.
    let convId = activeId;
    if (!convId) {
      const created = await createConversationAction();
      if (!created.ok) {
        toast.error(created.message);
        setSending(false);
        return;
      }
      convId = created.data.id;
      setActiveId(convId);
    }

    // Optimistic user bubble — lastIsUser becomes true → "thinking…" shows at once
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: 'user', content: message, jobId: null },
    ]);

    const res = await sendChatMessageAction({ conversationId: convId, message });
    if (!res.ok) toast.error(res.message);

    // Reconcile against the persisted thread (both turns written by runner)
    const refreshed = await listChatAction(convId);
    if (refreshed.ok) setMessages(refreshed.data.messages);

    // Refresh sidebar for updated title/recency
    await refreshConversations();
    setSending(false);
  }

  // ── Filtered + grouped sidebar conversations ──────────────────────────────
  const filtered = search.trim()
    ? conversations.filter((c) => c.title.toLowerCase().includes(search.toLowerCase()))
    : conversations;

  const groups = groupConversations(filtered);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full min-h-0 overflow-hidden rounded-xl border border-rule-2 bg-paper">
      {/* ── Thread (main, LEFT) ─────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Messages */}
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
          {loadingThread ? (
            <p className="py-8 text-center text-sm text-ink-4">Loading…</p>
          ) : messages.length === 0 && !lastIsUser ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-center text-sm text-ink-4">
                Say hello to {rootName ?? 'your ROOT agent'} 👋
              </p>
            </div>
          ) : (
            <>
              <div className="relative flex items-center justify-center py-1">
                <span className="absolute inset-x-0 top-1/2 h-px bg-rule-2" />
                <span className="relative bg-paper px-3 text-[10px] font-semibold uppercase tracking-widest text-ink-4">
                  Today
                </span>
              </div>
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} rootName={rootName} />
              ))}
              {lastIsUser && (
                <div className="flex justify-start gap-2.5">
                  <AgentAvatar rootName={rootName} />
                  <div className="flex max-w-[80%] flex-col items-start">
                    <div className="mb-1 flex items-center gap-1.5">
                      <span className="text-xs font-medium text-ink-2">{rootName ?? 'Agent'}</span>
                      <span className="rounded bg-ink/10 px-1 py-px text-[9px] font-semibold uppercase tracking-widest text-ink-3">
                        Orchestrator
                      </span>
                    </div>
                    <div className="rounded-2xl rounded-bl-sm border border-rule bg-canvas px-3.5 py-2 text-sm text-ink-4">
                      <span className="inline-flex items-center gap-1">
                        <span className="animate-pulse">●</span> thinking…
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Input — ALWAYS present. Typing with no active conversation creates one. */}
        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="flex items-end gap-2 border-t border-rule-2 p-3"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSubmit(e as unknown as React.FormEvent);
              }
            }}
            rows={1}
            placeholder={`Message ${rootName ?? 'your ROOT agent'}…`}
            className="max-h-40 min-h-[40px] flex-1 resize-y rounded-md border border-rule bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
          />
          <button
            type="submit"
            disabled={sending || input.trim().length === 0}
            className="inline-flex h-[40px] shrink-0 items-center rounded-md bg-ink px-4 text-sm font-medium text-canvas transition-[filter] hover:brightness-[0.92] disabled:opacity-40"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </form>
      </div>

      {/* ── Sidebar (RIGHT) ─────────────────────────────────────────────── */}
      <aside className="flex w-[300px] shrink-0 flex-col border-l border-rule-2">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-rule-2 px-4 py-3">
          <span className="text-sm font-semibold text-ink">Chat</span>
          <button
            type="button"
            onClick={() => void handleNew()}
            className="inline-flex items-center gap-1 rounded-md bg-ink px-2.5 py-1 text-xs font-medium text-canvas transition-[filter] hover:brightness-[0.92]"
          >
            + New
          </button>
        </div>

        {/* Search */}
        <div className="border-b border-rule-2 px-3 py-2.5">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search conversations…"
            className="w-full rounded-md border border-rule bg-canvas px-3 py-1.5 text-xs text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none"
          />
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-ink-4">
              {search.trim() ? 'No conversations match.' : 'No conversations yet — say hello.'}
            </p>
          ) : (
            groups.map(({ group, items }) => (
              <div key={group}>
                <div className="sticky top-0 bg-paper px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-4">
                  {group}
                </div>
                {items.map((c) => (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    active={c.id === activeId}
                    onSelect={() => void selectConversation(c.id)}
                    onDelete={() => setConfirmDeleteId(c.id)}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      </aside>

      {/* ── Delete confirm dialog ────────────────────────────────────────── */}
      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Delete conversation"
        message="This will permanently remove this conversation and all its messages."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        destructive
        onConfirm={() => {
          const id = confirmDeleteId;
          setConfirmDeleteId(null);
          if (id) void handleDelete(id);
        }}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ConversationRow({
  conversation,
  active,
  onSelect,
  onDelete,
}: {
  conversation: ConversationView;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const title = conversation.title.trim() || 'New conversation';
  const preview = conversation.preview.trim();
  const time = relativeTime(conversation.updatedAt);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect();
      }}
      className={`group relative flex cursor-pointer flex-col gap-0.5 px-4 py-2.5 transition-colors ${
        active ? 'bg-ink/8 text-ink' : 'hover:bg-ink/4 text-ink-2'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`truncate text-xs font-medium ${active ? 'text-ink' : 'text-ink-2'}`}>
          {title}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-[10px] text-ink-4">{time}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            aria-label="Delete conversation"
            className="ml-0.5 hidden rounded p-0.5 text-ink-4 transition-colors hover:text-err group-hover:inline-flex"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <polyline points="1 3 11 3" />
              <path d="M4 3V2h4v1" />
              <path d="M2 3l.8 7.2A1 1 0 003.8 11h4.4a1 1 0 001-.8L10 3" />
            </svg>
          </button>
        </div>
      </div>
      {preview && <p className="truncate text-[11px] text-ink-4">{preview}</p>}
    </div>
  );
}

function AgentAvatar({ rootName }: { rootName: string | null }) {
  const initial = (rootName ?? 'A').charAt(0).toUpperCase();
  return (
    <div className="mt-5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-run text-xs font-semibold text-ink">
      {initial}
    </div>
  );
}

function MessageBubble({
  message,
  rootName,
}: {
  message: ChatMessageView;
  rootName: string | null;
}) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end gap-2.5">
        <div className="flex max-w-[80%] flex-col items-end">
          <span className="mb-1 text-xs font-medium text-ink-3">You</span>
          <div className="whitespace-pre-wrap rounded-2xl rounded-br-sm bg-ink px-3.5 py-2 text-sm text-canvas">
            {message.content}
          </div>
        </div>
        <div className="mt-5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-ink/10 text-xs font-semibold text-ink-3">
          Y
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start gap-2.5">
      <AgentAvatar rootName={rootName} />
      <div className="flex max-w-[80%] flex-col items-start">
        <div className="mb-1 flex items-center gap-1.5">
          <span className="text-xs font-medium text-ink-2">{rootName ?? 'Agent'}</span>
          <span className="rounded bg-ink/10 px-1 py-px text-[9px] font-semibold uppercase tracking-widest text-ink-3">
            Orchestrator
          </span>
        </div>
        {message.content.trim() !== '' && (
          <div className="whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-rule bg-canvas px-3.5 py-2 text-sm text-ink-2">
            {message.content}
          </div>
        )}
        {message.jobId && <DispatchCard jobId={message.jobId} />}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const done = status === 'completed';
  const failed = status === 'failed' || status === 'cancelled';
  const label = done ? 'Done' : failed ? 'Failed' : 'Running';
  const cls = done
    ? 'border-ok/40 text-ok'
    : failed
      ? 'border-err/40 text-err'
      : 'border-run/40 text-run';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${cls}`}
    >
      {!done && !failed && <span className="animate-pulse">●</span>}
      {label}
    </span>
  );
}

function DispatchCard({ jobId }: { jobId: string }) {
  const [state, setState] = useState<ChatJobStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const r = await getChatJobStatusAction(jobId);
      if (cancelled) return;
      if (r.ok) setState(r.data);
      const done = r.ok && TERMINAL_JOB.has(r.data.status);
      if (!done && tries < 150) {
        tries += 1;
        timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  const status = state?.status ?? 'pending';
  const children = state?.children ?? [];

  return (
    <div className="mt-2 w-full rounded-lg border border-rule-2 bg-canvas/60 p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-ink-4">
          {children.length > 0
            ? `↘ Dispatched to ${children.length} agent${children.length > 1 ? 's' : ''}`
            : '↘ Task'}
        </span>
        {children.length === 0 && <StatusBadge status={status} />}
      </div>
      {children.length > 0 ? (
        <div className="space-y-1">
          {children.map((c, i) => (
            <div
              key={i}
              className="flex items-center justify-between rounded-md border border-rule bg-paper px-2.5 py-1.5"
            >
              <span className="truncate text-xs font-medium text-ink-2">{c.agentName}</span>
              <StatusBadge status={c.status} />
            </div>
          ))}
        </div>
      ) : null}
      {state && TERMINAL_JOB.has(status) && state.result && (
        <p className="mt-1.5 whitespace-pre-wrap text-xs text-ink-3">{state.result}</p>
      )}
    </div>
  );
}

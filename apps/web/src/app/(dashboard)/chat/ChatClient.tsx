'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  At,
  Checks,
  List,
  MagnifyingGlass,
  PaperPlaneTilt,
  Paperclip,
  Plus,
  Trash,
  X,
} from '@phosphor-icons/react';
import ConfirmDialog from '@/components/ConfirmDialog.tsx';
import RowActionButton from '@/components/ui/RowActionButton';
import IconButton from '@/components/ui/IconButton';
import TextArea from '@/components/ui/TextArea';
import TextInput from '@/components/ui/TextInput';

// useLayoutEffect runs synchronously after DOM mutation, BEFORE paint — so the
// scroll lands before the user ever sees the top. SSR-safe alias (no window on
// the server → fall back to useEffect to avoid the React warning).
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;
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
  // Mobile only: the conversation history is a slide-in drawer (on desktop it's
  // a static right pane). Closed by default so it never covers the thread.
  const [showHistory, setShowHistory] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Is the user at the bottom — i.e. "following" the live conversation? Drives
  // whether content growth auto-scrolls. Scrolling up to read history turns it
  // off; scrolling back to the bottom turns it on.
  const followRef = useRef(true);

  // A reply is in flight whenever the latest persisted message is a user turn.
  const lastIsUser = messages.length > 0 && messages[messages.length - 1]!.role === 'user';

  const pinToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Track follow state from the user's own scrolling.
  const handleMessagesScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // User action (open/switch thread, send a message) → follow + jump to bottom.
  useIsoLayoutEffect(() => {
    followRef.current = true;
    pinToBottom();
    const t = setTimeout(pinToBottom, 80); // catch the first async layout pass
    return () => clearTimeout(t);
  }, [messages, lastIsUser, loadingThread, pinToBottom]);

  // Stay glued to the bottom as the DOM GROWS while following — dispatch cards
  // fill in after their first poll (badges, sub-agent rows, result text), which
  // is exactly what pushed a one-shot scroll to mid-thread. A MutationObserver
  // fires on those content changes; we re-pin only when the user is following.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const mo = new MutationObserver(() => {
      if (followRef.current) el.scrollTop = el.scrollHeight;
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, []);

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
    setShowHistory(false); // close the mobile drawer on pick
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
    setShowHistory(false); // close the mobile drawer after creating
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

  // ── Filtered sidebar conversations (flat, by recency) ──────────────────────
  const filtered = search.trim()
    ? conversations.filter((c) => c.title.toLowerCase().includes(search.toLowerCase()))
    : conversations;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="relative flex h-full min-h-0 gap-4">
      {/* ── Thread (main, LEFT) — messages + input in a centered 680px column ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile-only header: title + button to open the history drawer. */}
        <div className="flex items-center justify-between gap-2 border-b border-rule-2 px-1 py-2 lg:hidden">
          <span className="truncate text-[13px] font-medium text-ink">{rootName ?? 'Chat'}</span>
          <RowActionButton
            onClick={() => setShowHistory(true)}
            icon={<List size={14} />}
            title="Show conversations"
            className="!px-2.5 !py-1 !text-[11px]"
          >
            Conversations
          </RowActionButton>
        </div>

        {/* Messages — scroll area; content lives in a 680px column centered in it. */}
        <div
          ref={scrollRef}
          onScroll={handleMessagesScroll}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto w-full max-w-[680px] px-4 py-6">
            {loadingThread ? (
              <p className="py-8 text-center text-[13px] text-ink-4">Loading…</p>
            ) : messages.length === 0 && !lastIsUser ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-center text-[13px] text-ink-4">
                  Say hello to {rootName ?? 'your ROOT agent'} 👋
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-7">
                <div className="flex items-center justify-center">
                  <span className="text-[11px] uppercase tracking-[0.14em] text-ink-3">Today</span>
                </div>
                {messages.map((m) => (
                  <MessageBubble key={m.id} message={m} rootName={rootName} />
                ))}
                {lastIsUser && (
                  <div className="flex gap-3">
                    <AgentAvatar rootName={rootName} />
                    <div className="min-w-0 flex-1 border-l-2 border-ink/10 pl-4">
                      <span className="text-[13px] font-medium text-ink">
                        {rootName ?? 'Agent'}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[13px] text-ink-4">
                        <span className="animate-pulse">●</span> thinking…
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Input — floating rounded card, same centered 680px column. */}
        <div className="shrink-0 px-4 pt-2 pb-4">
          <form
            onSubmit={(e) => void handleSubmit(e)}
            className="mx-auto w-full max-w-[680px] rounded-[22px] border border-rule-2 bg-paper shadow-[0_12px_20px_rgba(14,14,12,0.10)]"
          >
            <TextArea
              bare
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
              className="max-h-40 min-h-[24px] resize-none px-4 pt-3.5 text-[13px]"
            />
            <div className="flex items-center justify-between px-2.5 pt-1 pb-2.5">
              <div className="flex items-center gap-1">
                <IconButton
                  ghost
                  aria-label="Attachments — not available yet"
                  className="!size-8 !rounded-[10px] !text-ink-4 hover:!bg-hover hover:!text-ink-4"
                >
                  <Paperclip size={15} />
                </IconButton>
                <IconButton
                  ghost
                  aria-label="Mention an agent — not available yet"
                  className="!size-8 !rounded-[10px] !text-ink-4 hover:!bg-hover hover:!text-ink-4"
                >
                  <At size={15} />
                </IconButton>
                <span className="pl-1 text-[11px] text-ink-3">⌘ ↵ to send</span>
              </div>
              <IconButton
                type="submit"
                disabled={sending || input.trim().length === 0}
                aria-label="Send message"
                className="!size-8 !shrink-0 !rounded-full !border-0 !bg-hover-2 !text-ink-2 hover:!bg-hover disabled:!opacity-40"
              >
                <PaperPlaneTilt size={14} />
              </IconButton>
            </div>
          </form>
        </div>
      </div>

      {/* Backdrop — mobile only, dims the thread when the history drawer is open. */}
      {showHistory && (
        <div
          className="absolute inset-0 z-10 bg-black/40 lg:hidden"
          onClick={() => setShowHistory(false)}
          aria-hidden
        />
      )}

      {/* ── Conversation history ──────────────────────────────────────────
          Desktop (lg+): floating white card, static right pane, always shown.
          Mobile: a plain show/hide overlay — `hidden` (display:none) when
          closed so it can NEVER cover the thread, an absolute overlay when
          open. No transforms (which left it stuck visible). */}
      <aside
        className={`flex-col bg-paper lg:flex lg:static lg:z-auto lg:w-80 lg:shrink-0 lg:rounded-2xl lg:border lg:border-rule-2 lg:shadow-sm ${
          showHistory
            ? 'absolute inset-y-0 right-0 z-20 flex w-[85%] max-w-[320px] border-l border-rule-2 shadow-xl'
            : 'hidden'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <IconButton
              ghost
              onClick={() => setShowHistory(false)}
              aria-label="Close conversations"
              className="!size-auto !p-0 !text-ink-3 hover:!text-ink lg:hidden"
            >
              <X size={16} />
            </IconButton>
            <span className="text-sm font-semibold text-ink">Conversations</span>
          </div>
          <IconButton
            onClick={() => void handleNew()}
            aria-label="New conversation"
            className="!size-7 !rounded-full !border-0 !bg-ink !text-canvas transition-[filter] hover:!bg-ink hover:!brightness-[0.92]"
          >
            <Plus size={14} weight="bold" />
          </IconButton>
        </div>

        {/* Search */}
        <div className="px-3 pb-2.5">
          <div className="relative">
            <MagnifyingGlass
              size={14}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-4"
            />
            <TextInput
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search chats…"
              className="!rounded-lg !bg-canvas !pr-3 !pl-8 !text-xs"
            />
          </div>
        </div>

        {/* Conversation list — flat by recency (no date-group headers) */}
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-ink-4">
              {search.trim() ? 'No conversations match.' : 'No conversations yet — say hello.'}
            </p>
          ) : (
            filtered.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                active={c.id === activeId}
                onSelect={() => void selectConversation(c.id)}
                onDelete={() => setConfirmDeleteId(c.id)}
              />
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
      className={`group relative mx-2 flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2.5 transition-colors ${
        active ? 'bg-hover' : 'hover:bg-hover'
      }`}
    >
      <span
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-agent-vivid' : 'bg-ink-4/40'}`}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] font-medium text-ink">{title}</span>
          <div className="flex shrink-0 items-center gap-1">
            <span className="text-[11px] text-ink-4">{time}</span>
            {/* A real <button> nested inside the row's own role="button" div
                (ConversationRow) — valid, since that ancestor is a div, not an
                actual interactive element. stopPropagation on both events so
                neither the click nor the Enter/Space keydown also triggers the
                row's own onSelect. */}
            <IconButton
              ghost
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              onKeyDown={(e) => e.stopPropagation()}
              aria-label="Delete conversation"
              className="ml-0.5 !hidden !size-auto !rounded !p-0.5 !text-ink-4 group-hover:!inline-flex hover:!text-err"
            >
              <Trash size={12} />
            </IconButton>
          </div>
        </div>
        {preview && <p className="truncate text-[12px] text-ink-4">{preview}</p>}
      </div>
    </div>
  );
}

function AgentAvatar({ rootName }: { rootName: string | null }) {
  const initial = (rootName ?? 'A').charAt(0).toUpperCase();
  return (
    <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-[10px] bg-agent-vivid text-[11px] font-semibold text-ink">
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
    // Only a persisted message has round-tripped through the runner — the
    // optimistic local echo (id `local-…`) hasn't been confirmed sent yet.
    const sent = !message.id.startsWith('local-');
    return (
      <div className="flex flex-col items-end">
        {/* Bubble: rounded 16 all corners except a tucked bottom-right (the tail). */}
        <div className="max-w-[80%] whitespace-pre-wrap rounded-[16px] rounded-br-[6px] bg-ink px-4 py-2.5 text-[13px] leading-[20px] text-canvas">
          {message.content}
        </div>
        {sent && (
          <div className="flex items-center gap-1 pt-1.5 text-[11px] text-ink-3">
            {/* Time slot stays empty until ChatMessageView carries a timestamp —
                the sent indicator (double check) is real: the turn persisted. */}
            <Checks size={13} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <AgentAvatar rootName={rootName} />
      {/* Faint vertical rule down the content — the "avatar · line · name" motif. */}
      <div className="min-w-0 flex-1 border-l-2 border-ink/10 pl-4">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[13px] font-medium text-ink">{rootName ?? 'Agent'}</span>
          {/* Time slot — no per-message timestamp in the data, so left empty. */}
        </div>
        {message.content.trim() !== '' && (
          <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-[1.6] text-ink">
            {message.content}
          </p>
        )}
        {message.jobId && <DispatchCard jobId={message.jobId} />}
      </div>
    </div>
  );
}

// Pill — the rounded, dotted-status tag language from the mock (connector /
// skill pills). Only `neutral` is exercised today (dispatched agent names,
// which is real data); `connector`/`skill` are wired for when a message
// carries actual connector/skill metadata, so the primitive doesn't need to
// be redesigned later.
function Pill({
  variant,
  label,
  status,
}: {
  variant: 'connector' | 'skill' | 'neutral';
  label: string;
  status?: string;
}) {
  // Connector/skill pills are solid-fill with white text (the mock's tag
  // language); neutral (a dispatched-agent chip, the only real data today) is a
  // subtle fill carrying its own status dot.
  const styles = {
    connector: 'bg-connector text-white',
    skill: 'bg-skill text-white',
    neutral: 'bg-hover-2 text-ink-2',
  } as const;
  const done = status === 'completed';
  const failed = status === 'failed' || status === 'cancelled';
  const dotCls = done ? 'bg-ok' : failed ? 'bg-err' : 'bg-run';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[8px] px-1.5 py-0.5 text-[11px] font-medium ${styles[variant]}`}
    >
      {status && variant === 'neutral' && (
        <span
          className={`size-1.5 shrink-0 rounded-full ${dotCls} ${!done && !failed ? 'animate-pulse' : ''}`}
          aria-hidden
        />
      )}
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
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {children.length > 0 ? (
          children.map((c, i) => (
            <Pill key={i} variant="neutral" label={c.agentName} status={c.status} />
          ))
        ) : (
          <Pill variant="neutral" label="Task" status={status} />
        )}
      </div>
      {state && TERMINAL_JOB.has(status) && state.result && (
        <p className="whitespace-pre-wrap text-xs text-ink-3">{state.result}</p>
      )}
    </div>
  );
}

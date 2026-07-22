'use client';

// DelegationTable — the Runs view, from the Figma "Delegation" design.
// Runs are pre-ordered parent-then-children by the server action, so each
// orchestrator sits directly above the runs it delegated. Role is shown by a
// LEFT ACCENT bar + indentation (no role badges): orchestrator = lime,
// delegated = blue + indented "from X", standalone = none.
// The whole row is clickable (→ run detail) and its tooltip is the task.
// Theme-aware (semantic tokens + StatusPill/AgentAvatar) and responsive.
//
// Conversation grouping (migration 0059): rows come in pre-grouped from the
// server (groupJobsForJobsPage, apps/web/src/lib/jobs-grouping.ts) — a chat
// exchange (Telegram DM, dashboard chat) collapses into one 💬 row with an
// exchange count; clicking it expands the individual jobs inline, rendered
// with the exact same row markup as a standalone job. A task job that still
// belongs to a conversation (e.g. a Telegram message that triggered
// run_command) stays its own top-level row, with a small 💬 badge next to
// its agent name linking it back to that thread.

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DelegationRunRow } from '@/lib/actions.ts';
import type { JobsPageRow, ConversationGroupRow } from '@/lib/jobs-grouping.ts';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import AgentAvatar from '@/components/ui/AgentAvatar';
import Table, { THead, Th, Tr, Td } from '@/components/ui/Table';
import {
  ArrowElbowDownRight,
  Clock,
  PaperPlaneTilt,
  Browser,
  ChatCircleDots,
  CaretRight,
  CaretDown,
} from '@phosphor-icons/react';

const ACCENT: Record<DelegationRunRow['role'], string> = {
  orchestrator: '#d4ff2e',
  delegated: '#3565ff',
  standalone: 'transparent',
};

function statusVariant(status: string | null): StatusVariant {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'cancelled') return 'warn';
  if (status === 'processing' || status === 'pending' || (status?.startsWith('awaiting') ?? false))
    return 'run';
  return 'idle';
}
function statusLabel(status: string | null): string {
  const MAP: Record<string, string> = {
    pending: 'Queued',
    processing: 'Running',
    completed: 'Done',
    failed: 'Failed',
    awaiting_approval: 'Awaiting',
    awaiting_delegation: 'Awaiting',
    cancelled: 'Cancelled',
  };
  return MAP[status ?? ''] ?? 'Pending';
}
function conversationStatusVariant(status: ConversationGroupRow['status']): StatusVariant {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'warn';
  return 'run';
}
function conversationStatusLabel(status: ConversationGroupRow['status']): string {
  if (status === 'completed') return 'Done';
  if (status === 'failed') return 'Failed';
  return 'Running';
}

// "Trigger" = what actually kicked off the top-level run. Only orchestrator /
// standalone runs have a real one (Cron / Telegram / Dashboard). A DELEGATED run
// has no trigger of its own — it was spawned by its orchestrator, whose trigger
// shows one row above. (NodalAI has no Kanban "task board"; channels like
// `task-board` / `internal` are just delegation mechanics, not real triggers, so
// they're never surfaced as a trigger.)
type Trig = { label: string; cls: string; Icon: typeof Clock };
const CRON: Trig = { label: 'Cron', cls: 'bg-agent-vivid text-[#1a2200]', Icon: Clock };
const TELEGRAM: Trig = { label: 'Telegram', cls: 'bg-conn-vivid text-white', Icon: PaperPlaneTilt };
const DASHBOARD: Trig = { label: 'Dashboard', cls: 'bg-ink-3 text-paper', Icon: Browser };
const TRIGGER_LEGEND: Trig[] = [CRON, TELEGRAM, DASHBOARD];

function triggerForChannel(role: DelegationRunRow['role'], channel: string): Trig | null {
  if (role === 'delegated') return null; // inherits its orchestrator's trigger
  if (channel === 'cron') return CRON;
  if (channel === 'telegram') return TELEGRAM;
  if (channel === 'dashboard' || channel === 'api') return DASHBOARD;
  return null; // internal / task-board / other → no real external trigger
}

const isLive = (s: string | null) =>
  s === 'processing' || s === 'pending' || (s?.startsWith('awaiting') ?? false);
const pad = (n: number) => String(n).padStart(2, '0');

function startedLabel(createdAt: Date | null, status: string | null): string {
  if (isLive(status) && createdAt) {
    const sec = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
    return `live · ${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
  }
  if (!createdAt) return '—';
  return new Date(createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function durationLabel(c: Date | null, d: Date | null, status: string | null): string {
  if (isLive(status) || !c || !d) return '—';
  const sec = Math.max(0, Math.floor((new Date(d).getTime() - new Date(c).getTime()) / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${pad(sec % 60)}s` : `${sec}s`;
}
function rangeLabel(first: Date | null, last: Date | null): string {
  if (!first) return '—';
  const f = new Date(first).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (!last || last.getTime() === first.getTime()) return f;
  const l = new Date(last).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${f} → ${l}`;
}
// Abbreviate token counts: 5210 → 5.2K, 102340 → 102K, 1043772 → 1.0M.
function abbrevTokens(n: number): string {
  if (n <= 0) return '—';
  if (n < 1000) return String(n);
  const trim = (x: number) => (Math.round(x * 10) / 10).toString().replace(/\.0$/, '');
  if (n < 1_000_000) return (n / 1000 >= 100 ? String(Math.round(n / 1000)) : trim(n / 1000)) + 'K';
  return (n / 1_000_000 >= 100 ? String(Math.round(n / 1_000_000)) : trim(n / 1_000_000)) + 'M';
}

export default function DelegationTable({
  rows,
  query = '',
}: {
  rows: JobsPageRow[];
  query?: string;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (conversationId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(conversationId)) next.delete(conversationId);
      else next.add(conversationId);
      return next;
    });
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      if (r.kind === 'conversation') {
        return (
          r.agentName.toLowerCase().includes(q) ||
          r.jobs.some((j) => j.task.toLowerCase().includes(q))
        );
      }
      return (
        r.job.agentName.toLowerCase().includes(q) ||
        r.job.task.toLowerCase().includes(q) ||
        (r.job.fromAgentName?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [rows, query]);

  return (
    <div>
      <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper">
        {/* Legend — decodes the trigger icons */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5 border-b border-rule-2 px-5 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-legacy-10 uppercase tracking-[0.12em] text-ink-4">
              Trigger
            </span>
            {TRIGGER_LEGEND.map((t) => (
              <span
                key={t.label}
                className="inline-flex items-center gap-1.5 text-legacy-11 text-ink-3"
              >
                <span
                  className={`inline-flex size-[16px] items-center justify-center rounded ${t.cls}`}
                >
                  <t.Icon size={10} weight="fill" />
                </span>
                {t.label}
              </span>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="px-6 py-12 text-center text-body-14 text-ink-4">
            {rows.length === 0 ? 'No runs yet.' : 'No runs match the search.'}
          </div>
        ) : (
          <Table frame={false}>
            <THead>
              <Th>Agent</Th>
              <Th>Trigger</Th>
              <Th className="hidden md:table-cell">Started</Th>
              <Th align="right" className="hidden lg:table-cell">
                Duration
              </Th>
              <Th align="right">Tokens</Th>
              <Th align="right" className="hidden sm:table-cell">
                Cost
              </Th>
              <Th align="right">Status</Th>
            </THead>
            <tbody>
              {filtered.map((row) =>
                row.kind === 'conversation' ? (
                  <ConversationRows
                    key={row.conversationId}
                    row={row}
                    isExpanded={expanded.has(row.conversationId)}
                    onToggle={() => toggle(row.conversationId)}
                    onOpenJob={(id) => router.push(`/jobs/${id}`)}
                  />
                ) : (
                  <JobRowTr
                    key={row.job.id}
                    r={row.job}
                    onOpen={() => router.push(`/jobs/${row.job.id}`)}
                  />
                ),
              )}
            </tbody>
          </Table>
        )}
      </div>
    </div>
  );
}

// ─── One job row (standalone/orchestrator/delegated), also reused for an
// expanded conversation's individual exchanges ───────────────────────────────

function JobRowTr({
  r,
  onOpen,
  indented = false,
}: {
  r: DelegationRunRow;
  onOpen: () => void;
  indented?: boolean;
}) {
  const delegated = r.role === 'delegated';
  // Cache-aware input (falls back to raw for pre-migration-0036 rows, where
  // effectiveInputTokens defaults to 0).
  const tokens = (r.effectiveInputTokens || r.inputTokens) + r.outputTokens;
  const trig = triggerForChannel(r.role, r.channel);
  return (
    <Tr
      title={r.task}
      onClick={onOpen}
      interactive
      hover={false}
      className={`hover:bg-hover-2 ${delegated || indented ? 'bg-hover' : ''}`}
    >
      <Td style={{ boxShadow: `inset 3px 0 0 ${ACCENT[r.role]}` }}>
        <div className={`flex items-center gap-2.5 ${delegated || indented ? 'pl-2' : ''}`}>
          {(delegated || indented) && (
            <ArrowElbowDownRight size={14} className="shrink-0 text-ink-4" />
          )}
          <AgentAvatar name={r.agentName} imageUrl={r.agentAvatarUrl} size="md" />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-body-13 text-ink">
              {/* Agent name ONLY — the task text lives in the row tooltip
                  (title={r.task}), never as visible cell text: the design pass
                  (b29bdf2) removed it because it blows the table width and
                  pushes columns out of frame. Regression fixed 2026-07-08. */}
              <span className="truncate">{r.agentName}</span>
              {/* Badge (migration 0059): this job belongs to a conversation but
                  wasn't collapsed into it (it did real work, not just chat) —
                  a discreet 💬 links it back visually. */}
              {r.conversationId && !indented && (
                <span title="Part of a conversation" className="inline-flex shrink-0">
                  <ChatCircleDots size={12} className="text-ink-4" />
                </span>
              )}
            </div>
            {delegated && r.fromAgentName && (
              <div className="truncate text-legacy-11 leading-tight! text-ink-3">
                from {r.fromAgentName}
              </div>
            )}
          </div>
        </div>
      </Td>
      <Td>
        {trig ? (
          <div className="flex items-center gap-2">
            <span
              title={trig.label}
              className={`inline-flex size-[24px] shrink-0 items-center justify-center rounded-md ${trig.cls}`}
            >
              <trig.Icon size={13} weight="fill" />
            </span>
            {/* Which schedule fired this cron run (trigger_context, migration
                0061) — null on cron rows predating that column. */}
            {trig === CRON && r.scheduleName && (
              <span
                title={r.scheduleName}
                className="max-w-[140px] truncate text-legacy-11 leading-tight! text-ink-3"
              >
                {r.scheduleName}
              </span>
            )}
          </div>
        ) : (
          <span className="text-body-13 text-ink-4">—</span>
        )}
      </Td>
      <Td className="hidden text-body-13 whitespace-nowrap text-ink-2 md:table-cell">
        {startedLabel(r.createdAt, r.status)}
      </Td>
      <Td align="right" className="hidden text-mono-13 whitespace-nowrap text-ink-2 lg:table-cell">
        {durationLabel(r.createdAt, r.completedAt, r.status)}
      </Td>
      <Td align="right" className="text-mono-13 whitespace-nowrap text-ink-2">
        {abbrevTokens(tokens)}
      </Td>
      <Td align="right" className="hidden text-mono-13 whitespace-nowrap text-ink-2 sm:table-cell">
        {r.costUsd > 0 ? `$${r.costUsd.toFixed(2)}` : '—'}
      </Td>
      <Td align="right">
        <StatusPill variant={statusVariant(r.status)} label={statusLabel(r.status)} />
      </Td>
    </Tr>
  );
}

// ─── A collapsed conversation summary row + its expanded members ───────────

function ConversationRows({
  row,
  isExpanded,
  onToggle,
  onOpenJob,
}: {
  row: ConversationGroupRow;
  isExpanded: boolean;
  onToggle: () => void;
  onOpenJob: (jobId: string) => void;
}) {
  const trig = triggerForChannel('standalone', row.channel);
  return (
    <>
      <Tr
        onClick={onToggle}
        title={`${row.exchangeCount} exchange${row.exchangeCount === 1 ? '' : 's'}`}
        interactive
        hover={false}
        className="hover:bg-hover-2"
      >
        <Td>
          <div className="flex items-center gap-2.5">
            {isExpanded ? (
              <CaretDown size={12} className="shrink-0 text-ink-4" />
            ) : (
              <CaretRight size={12} className="shrink-0 text-ink-4" />
            )}
            <AgentAvatar name={row.agentName} imageUrl={row.agentAvatarUrl} size="md" />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 truncate text-body-13 text-ink">
                <ChatCircleDots size={13} className="shrink-0 text-ink-4" />
                {row.agentName}
              </div>
              <div className="truncate text-legacy-11 leading-tight! text-ink-3">
                {row.exchangeCount} exchange{row.exchangeCount === 1 ? '' : 's'}
              </div>
            </div>
          </div>
        </Td>
        <Td>
          {trig ? (
            <span
              title={trig.label}
              className={`inline-flex size-[24px] items-center justify-center rounded-md ${trig.cls}`}
            >
              <trig.Icon size={13} weight="fill" />
            </span>
          ) : (
            <span className="text-body-13 text-ink-4">—</span>
          )}
        </Td>
        <Td className="hidden text-body-13 whitespace-nowrap text-ink-2 md:table-cell">
          {rangeLabel(row.firstCreatedAt, row.lastActivityAt)}
        </Td>
        <Td align="right" className="hidden text-body-13 text-ink-4 lg:table-cell">
          —
        </Td>
        <Td align="right" className="text-mono-13 whitespace-nowrap text-ink-2">
          {abbrevTokens(row.totalTokens)}
        </Td>
        <Td
          align="right"
          className="hidden text-mono-13 whitespace-nowrap text-ink-2 sm:table-cell"
        >
          {row.totalCostUsd > 0 ? `$${row.totalCostUsd.toFixed(2)}` : '—'}
        </Td>
        <Td align="right">
          <StatusPill
            variant={conversationStatusVariant(row.status)}
            label={conversationStatusLabel(row.status)}
          />
        </Td>
      </Tr>
      {isExpanded &&
        row.jobs.map((j) => <JobRowTr key={j.id} r={j} onOpen={() => onOpenJob(j.id)} indented />)}
    </>
  );
}

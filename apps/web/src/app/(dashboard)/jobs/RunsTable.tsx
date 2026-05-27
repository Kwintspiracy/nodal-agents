'use client';

// RunsTable — interactive filter + table for the Runs list page.
// Server-rendered shell in page.tsx, this client component owns search +
// tab filtering so the page can remain force-dynamic without a full refresh
// per keystroke.

import { useState, useMemo } from 'react';
import Link from 'next/link';
import type { JobRow, AgentRow } from '@/lib/actions.ts';
import PillTabs from '@/components/ui/PillTabs';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import AgentAvatar from '@/components/ui/AgentAvatar';
import { MagnifyingGlass } from '@phosphor-icons/react';

type Tab = 'All' | 'Running' | 'Failed';

const TABS: { value: Tab; label: string }[] = [
  { value: 'All', label: 'All' },
  { value: 'Running', label: 'Running' },
  { value: 'Failed', label: 'Failed' },
];

function statusToVariant(status: string | null): StatusVariant {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'cancelled') return 'warn';
  if (status === 'processing' || status === 'pending' || status?.startsWith('awaiting'))
    return 'run';
  return 'idle';
}

function statusLabel(status: string | null): string {
  if (!status) return 'Pending';
  const MAP: Record<string, string> = {
    pending: 'Pending',
    processing: 'Running',
    completed: 'Done',
    failed: 'Failed',
    awaiting_approval: 'Awaiting',
    awaiting_delegation: 'Awaiting',
    cancelled: 'Cancelled',
  };
  return MAP[status] ?? status;
}

function formatDate(d: Date | null): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

type Props = {
  jobs: JobRow[];
  agents: AgentRow[];
  /** Pre-filter: only show jobs for this agent ID when set. */
  agentId?: string | null;
};

export default function RunsTable({ jobs, agents, agentId }: Props) {
  const [tab, setTab] = useState<Tab>('All');
  const [query, setQuery] = useState('');

  // Build a lookup so we can show agent name + avatar without extra fetches.
  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const filtered = useMemo(() => {
    let list = agentId ? jobs.filter((j) => j.agentId === agentId) : jobs;

    if (tab === 'Running') {
      list = list.filter((j) => {
        const s = j.status ?? '';
        return s === 'processing' || s === 'pending' || s.startsWith('awaiting');
      });
    } else if (tab === 'Failed') {
      list = list.filter((j) => j.status === 'failed' || j.status === 'cancelled');
    }

    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((j) => {
        const agent = j.agentId ? (agentMap.get(j.agentId)?.name ?? '') : '';
        return (
          j.task.toLowerCase().includes(q) ||
          agent.toLowerCase().includes(q) ||
          j.channel.toLowerCase().includes(q)
        );
      });
    }

    return list;
  }, [jobs, agentId, tab, query, agentMap]);

  return (
    <div>
      {/* Filter row */}
      <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
        <PillTabs
          tabs={TABS}
          defaultValue="All"
          variant="dark-active"
          onChange={(v) => setTab(v as Tab)}
        />
        <div className="ml-auto flex h-[34px] min-w-[240px] items-center gap-2 rounded-md border border-rule-2 bg-paper px-3 text-[12.5px] text-ink-4">
          <MagnifyingGlass size={13} className="shrink-0" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by task or agent…"
            className="flex-1 border-0 bg-transparent text-[13px] leading-none text-ink outline-none placeholder:text-ink-4"
          />
        </div>
      </div>

      {/* Table card */}
      <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper">
        {filtered.length === 0 ? (
          <div className="px-6 py-12 text-center text-[13px] text-ink-4">
            {jobs.length === 0
              ? 'No runs yet. Use the form above to send your first task to an agent.'
              : 'No runs match the current filter.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  <Th>Agent</Th>
                  <Th>Task</Th>
                  <Th className="hidden md:table-cell">Channel</Th>
                  <Th className="hidden lg:table-cell">Started</Th>
                  <Th align="right">Status</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((job) => {
                  const agent = job.agentId ? agentMap.get(job.agentId) : null;
                  const variant = statusToVariant(job.status);
                  return (
                    <tr
                      key={job.id}
                      className="border-b border-dashed border-rule-2 last:border-0 hover:bg-hover transition-colors"
                    >
                      {/* Agent */}
                      <td className="px-[18px] py-3 align-middle">
                        {agent ? (
                          <div className="flex items-center gap-2.5">
                            <AgentAvatar
                              name={agent.name}
                              imageUrl={agent.avatarUrl}
                              size="md"
                              shape="round"
                            />
                            <div className="min-w-0">
                              <div className="truncate text-[13px] font-medium leading-[1.2] text-ink">
                                {agent.name}
                              </div>
                              <div className="truncate font-mono text-[10px] leading-none text-ink-4">
                                {agent.slug}
                              </div>
                            </div>
                          </div>
                        ) : (
                          <span className="font-mono text-[11px] text-ink-4">—</span>
                        )}
                      </td>

                      {/* Task */}
                      <td className="max-w-[320px] px-[18px] py-3 align-middle">
                        <Link
                          href={`/jobs/${job.id}`}
                          className="line-clamp-1 text-[13px] text-ink-2 hover:text-ink transition-colors"
                          title={job.task}
                        >
                          {truncate(job.task, 72)}
                        </Link>
                      </td>

                      {/* Channel */}
                      <td className="hidden px-[18px] py-3 align-middle font-mono text-[11px] text-ink-4 md:table-cell">
                        {job.channel}
                      </td>

                      {/* Started */}
                      <td className="hidden px-[18px] py-3 align-middle font-mono text-[11px] text-ink-4 lg:table-cell">
                        {formatDate(job.createdAt)}
                      </td>

                      {/* Status */}
                      <td className="px-[18px] py-3 align-middle text-right">
                        <StatusPill variant={variant} label={statusLabel(job.status)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Mini table header cell ─────────────────────────────────────────────────

function Th({
  children,
  align = 'left',
  className = '',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <th
      className={`border-b border-rule-2 px-[18px] pt-1.5 pb-2.5 font-mono text-[9.5px] font-normal uppercase tracking-[0.16em] text-ink-4 ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${className}`}
    >
      {children}
    </th>
  );
}

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
import TextInput from '@/components/ui/TextInput';
import Table, { THead, Th, Tr, Td } from '@/components/ui/Table';
import { MagnifyingGlass } from '@phosphor-icons/react';
import { formatDate, truncate } from '@/lib/format-time';

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
        <div className="relative ml-auto min-w-[240px]">
          <MagnifyingGlass
            size={13}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-4"
          />
          <TextInput
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by task or agent…"
            className="pl-8 text-body-13"
          />
        </div>
      </div>

      {/* Table card */}
      {filtered.length === 0 ? (
        <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center text-body-14 text-ink-4">
          {jobs.length === 0
            ? 'No runs yet. Use the form above to send your first task to an agent.'
            : 'No runs match the current filter.'}
        </div>
      ) : (
        <Table>
          <THead>
            <Th>Agent</Th>
            <Th>Task</Th>
            <Th className="hidden md:table-cell">Channel</Th>
            <Th className="hidden lg:table-cell">Started</Th>
            <Th align="right">Status</Th>
          </THead>
          <tbody>
            {filtered.map((job) => {
              const agent = job.agentId ? agentMap.get(job.agentId) : null;
              const variant = statusToVariant(job.status);
              return (
                <Tr key={job.id}>
                  {/* Agent */}
                  <Td>
                    {agent ? (
                      <div className="flex items-center gap-2.5">
                        <AgentAvatar
                          name={agent.name}
                          imageUrl={agent.avatarUrl}
                          size="md"
                          shape="round"
                        />
                        <div className="min-w-0">
                          <div className="truncate text-medium-14 leading-[1.2]! text-ink">
                            {agent.name}
                          </div>
                          <div className="truncate text-mono-11 leading-none! text-ink-4">
                            {agent.slug}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <span className="text-mono-12 text-ink-4">—</span>
                    )}
                  </Td>

                  {/* Task */}
                  <Td className="max-w-[320px]">
                    <Link
                      href={`/jobs/${job.id}`}
                      className="line-clamp-1 text-body-14 text-ink-2 hover:text-ink transition-colors"
                      title={job.task}
                    >
                      {truncate(job.task, 72)}
                    </Link>
                  </Td>

                  {/* Channel */}
                  <Td className="hidden text-mono-12 text-ink-4 md:table-cell">{job.channel}</Td>

                  {/* Started */}
                  <Td className="hidden text-mono-12 text-ink-4 lg:table-cell">
                    {formatDate(job.createdAt)}
                  </Td>

                  {/* Status */}
                  <Td align="right">
                    <StatusPill variant={variant} label={statusLabel(job.status)} />
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </div>
  );
}

'use client';

// CodeProcessesTable — the /code list: one row per coding process (a job that
// did coding, or a runtime chat session). Polls listCodingProcessesAction
// every 5s while at least one row is still 'coding' — cleanup on unmount, same
// interval-effect shape as JobStatusPoller.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { listCodingProcessesAction, type CodingProcessRow } from '@/lib/actions.ts';
import Table, { THead, Th, Tr, Td } from '@/components/ui/Table';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import AgentAvatar from '@/components/ui/AgentAvatar';
import { relativeTime } from '@/lib/format-time';

const POLL_INTERVAL = 5000;

const STAGE_LABEL: Record<string, string> = {
  coding: 'Coding',
  delegated: 'Delegated',
  review: 'Review',
  done: 'Done',
  done_approved: 'Done · Approved',
  failed: 'Failed',
  chat: 'Chat',
};

function stageVariant(stage: string): StatusVariant {
  if (stage === 'coding' || stage === 'delegated' || stage === 'review') return 'run';
  if (stage === 'done' || stage === 'done_approved') return 'done';
  if (stage === 'failed') return 'warn';
  return 'idle';
}

function stageLabel(stage: string): string {
  return STAGE_LABEL[stage] ?? stage;
}

function processHref(row: CodingProcessRow): string {
  return `/code/${row.kind}-${row.id}`;
}

export default function CodeProcessesTable({
  initialRows,
  error,
}: {
  initialRows: CodingProcessRow[];
  error?: string;
}) {
  const [rows, setRows] = useState<CodingProcessRow[]>(initialRows);
  // A ref mirrors `rows` so the polling effect can read the latest list
  // without depending on it (an interval that resets every fetch would never
  // hold steady at 5s). Synced in an effect, never during render.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    const hasCoding = () => rowsRef.current.some((r) => r.stage === 'coding');
    if (!hasCoding()) return;

    const id = setInterval(() => {
      if (!hasCoding()) return;
      void listCodingProcessesAction().then((result) => {
        if (result.ok) setRows(result.data);
      });
    }, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [rows]);

  if (error) {
    return (
      <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center text-body-14 text-err">
        {error}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center text-body-14 text-ink-4">
        No coding activity yet. Attach the Coding CLI capability to an agent, or switch one to the
        Claude Code runtime, to see processes here.
      </div>
    );
  }

  return (
    <Table>
      <THead>
        <Th>Agent</Th>
        <Th>Task</Th>
        <Th className="hidden md:table-cell">Origin</Th>
        <Th>Stage</Th>
        <Th align="right" className="hidden sm:table-cell">
          Files
        </Th>
        <Th align="right" className="hidden sm:table-cell">
          Cost
        </Th>
        <Th align="right">Age</Th>
      </THead>
      <tbody>
        {rows.map((row) => (
          <Tr key={`${row.kind}-${row.id}`}>
            <Td>
              <Link href={processHref(row)} className="flex items-center gap-2.5">
                <AgentAvatar name={row.agentName ?? '?'} size="md" shape="round" />
                <span className="truncate text-medium-14 leading-[1.2]! text-ink">
                  {row.agentName ?? 'Unknown agent'}
                </span>
              </Link>
            </Td>
            <Td className="max-w-[320px]">
              <Link
                href={processHref(row)}
                className="line-clamp-1 text-body-14 text-ink-2 transition-colors hover:text-ink"
                title={row.task}
              >
                {row.task}
              </Link>
            </Td>
            <Td className="hidden md:table-cell">
              <MonoMicroTag tone="ink">{row.origin}</MonoMicroTag>
            </Td>
            <Td>
              <StatusPill variant={stageVariant(row.stage)} label={stageLabel(row.stage)} />
            </Td>
            <Td align="right" className="hidden text-mono-12 text-ink-3 sm:table-cell">
              {row.filesChanged > 0 ? row.filesChanged : '—'}
            </Td>
            <Td align="right" className="hidden text-mono-12 text-ink-3 sm:table-cell">
              {row.costUsd > 0 ? `$${row.costUsd.toFixed(2)}` : '—'}
            </Td>
            <Td align="right" className="text-mono-12 text-ink-4">
              {relativeTime(row.activityAt)}
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

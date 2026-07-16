'use client';

import { useState } from 'react';
import type { AgentRow } from '@/lib/actions.ts';
import type { JobsPageRow } from '@/lib/jobs-grouping.ts';
import PageTopBar from '@/components/ui/PageTopBar';
import PageSearchInput from '@/components/ui/PageSearchInput';
import SendTaskForm from '@/components/SendTaskForm.tsx';
import DelegationTable from './DelegationTable.tsx';

/**
 * JobsRuns — owns the Runs toolbar (search + "New task") and the runs table,
 * sharing the search query between them (the search sits in the toolbar next to
 * the button, like every other page — not below the table).
 */
export default function JobsRuns({
  rows,
  agents,
  error,
}: {
  rows: JobsPageRow[];
  agents: AgentRow[];
  error?: string;
}) {
  const [query, setQuery] = useState('');

  return (
    <>
      <div className="mb-5">
        <PageTopBar
          search={
            <PageSearchInput
              value={query}
              onChange={setQuery}
              placeholder="Search by agent or task…"
            />
          }
          cta={<SendTaskForm agents={agents} />}
        />
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-warn/40 bg-warn-bg p-4 text-body-14 text-warn">
          {error}
        </div>
      )}

      <DelegationTable rows={rows} query={query} />
    </>
  );
}

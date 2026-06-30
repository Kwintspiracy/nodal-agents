import Link from 'next/link';
import { listAgentsAction, listToolCallsAction, listToolNamesAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import LogFilters from './LogFilters.tsx';
import LogsTable from './LogsTable.tsx';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

interface PageProps {
  searchParams: Promise<{
    agent?: string;
    tool?: string;
    job?: string;
    page?: string;
  }>;
}

export default async function LogsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);

  const [agentsResult, toolNamesResult, result] = await Promise.all([
    listAgentsAction(),
    listToolNamesAction(),
    listToolCallsAction({
      agentId: sp.agent || undefined,
      toolName: sp.tool || undefined,
      jobId: sp.job || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
  ]);

  const agents = agentsResult.ok ? agentsResult.data : [];
  const toolNames = toolNamesResult.ok ? toolNamesResult.data : [];

  if (!result.ok) {
    return (
      <PageShell title="Logs">
        <div className="rounded-xl border border-err/25 bg-paper px-6 py-8 text-sm text-err">
          {result.message}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Logs"
      subtitle="Recent tool calls across the fleet."
      toolbar={<LogFilters agents={agents} toolNames={toolNames} />}
    >
      <div className="space-y-6">
        {result.data.items.length === 0 ? (
          <div className="rounded-xl border border-rule-2 bg-paper px-6 py-12 text-center text-sm text-ink-4">
            No tool calls yet. Send a task on the Tasks page to generate some.
          </div>
        ) : (
          <LogsTable items={result.data.items} />
        )}

        {result.data.items.length === PAGE_SIZE && <Pagination page={page} sp={sp} />}
      </div>
    </PageShell>
  );
}

function Pagination({ page, sp }: { page: number; sp: Awaited<PageProps['searchParams']> }) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v && k !== 'page') params.set(k, v);
  }
  const next = new URLSearchParams(params);
  next.set('page', String(page + 1));
  const prev = new URLSearchParams(params);
  prev.set('page', String(Math.max(1, page - 1)));

  return (
    <div className="flex items-center justify-between text-xs text-ink-3">
      <span>Page {page}</span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link
            href={`/logs?${prev.toString()}`}
            className="rounded-md border border-rule-2 px-3 py-1.5 transition-colors hover:border-rule hover:text-ink"
          >
            Previous
          </Link>
        ) : (
          <span className="rounded-md border border-rule px-3 py-1.5 text-ink-4">Previous</span>
        )}
        <Link
          href={`/logs?${next.toString()}`}
          className="rounded-md border border-rule-2 px-3 py-1.5 transition-colors hover:border-rule hover:text-ink"
        >
          Next
        </Link>
      </div>
    </div>
  );
}

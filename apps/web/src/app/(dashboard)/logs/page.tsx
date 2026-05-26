import Link from 'next/link';
import { listAgentsAction, listToolCallsAction, listToolNamesAction } from '@/lib/actions.ts';
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
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-white">Logs</h1>
        <div className="bg-neutral-900 border border-red-900/40 rounded-xl px-6 py-8 text-sm text-red-300">
          {result.message}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Logs</h1>
        <p className="text-sm text-neutral-500 mt-0.5">
          {result.data.items.length === PAGE_SIZE
            ? `Showing latest ${PAGE_SIZE} tool calls`
            : `${result.data.items.length} tool call${result.data.items.length === 1 ? '' : 's'}`}
          {sp.job && (
            <>
              {' '}
              for job{' '}
              <Link
                href={`/jobs/${sp.job}`}
                className="font-mono text-neutral-300 hover:text-white"
              >
                {sp.job.slice(0, 8)}
              </Link>
            </>
          )}
        </p>
      </div>

      <LogFilters agents={agents} toolNames={toolNames} />

      {result.data.items.length === 0 ? (
        <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-6 py-12 text-center text-neutral-600 text-sm">
          No tool calls yet. Send a task on the Tasks page to generate some.
        </div>
      ) : (
        <LogsTable items={result.data.items} />
      )}

      {result.data.items.length === PAGE_SIZE && <Pagination page={page} sp={sp} />}
    </div>
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
    <div className="flex items-center justify-between text-xs text-neutral-500">
      <span>Page {page}</span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link
            href={`/logs?${prev.toString()}`}
            className="px-3 py-1.5 border border-neutral-800 rounded-md hover:border-neutral-700 hover:text-white"
          >
            Previous
          </Link>
        ) : (
          <span className="px-3 py-1.5 border border-neutral-900 text-neutral-700 rounded-md">
            Previous
          </span>
        )}
        <Link
          href={`/logs?${next.toString()}`}
          className="px-3 py-1.5 border border-neutral-800 rounded-md hover:border-neutral-700 hover:text-white"
        >
          Next
        </Link>
      </div>
    </div>
  );
}

import Link from 'next/link';
import { listAgentsAction, listToolCallsAction } from '@/lib/actions.ts';
import LogFilters from './LogFilters.tsx';

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

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function isErrorOutput(output: string | null): boolean {
  if (!output) return false;
  return /^(error|\[ERROR|Error:|RuntimeError)/i.test(output.trim());
}

export default async function LogsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);

  const agentsResult = await listAgentsAction();
  const result = await listToolCallsAction({
    agentId: sp.agent || undefined,
    toolName: sp.tool || undefined,
    jobId: sp.job || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const agents = agentsResult.ok ? agentsResult.data : [];

  if (!result.ok) {
    return (
      <div className="space-y-6 max-w-6xl">
        <h1 className="text-2xl font-bold text-white">Logs</h1>
        <div className="bg-neutral-900 border border-red-900/40 rounded-xl px-6 py-8 text-sm text-red-300">
          {result.message}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-6xl">
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

      <LogFilters agents={agents} />

      {result.data.items.length === 0 ? (
        <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-6 py-12 text-center text-neutral-600 text-sm">
          No tool calls yet. Send a task on the Tasks page to generate some.
        </div>
      ) : (
        <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-800/60">
                <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider">
                  Time
                </th>
                <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider">
                  Tool
                </th>
                <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider hidden md:table-cell">
                  Agent
                </th>
                <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider hidden lg:table-cell">
                  Duration
                </th>
                <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider hidden lg:table-cell">
                  Job
                </th>
              </tr>
            </thead>
            <tbody>
              {result.data.items.map((c) => (
                <tr key={c.id} className="border-b border-neutral-800/40 last:border-0 align-top">
                  <td className="px-5 py-3 text-xs text-neutral-500 whitespace-nowrap">
                    {c.createdAt ? new Date(c.createdAt).toLocaleTimeString() : '—'}
                    <div className="text-[10px] text-neutral-600">
                      {c.createdAt ? new Date(c.createdAt).toLocaleDateString() : ''}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <code
                      className={`font-mono text-xs ${
                        isErrorOutput(c.toolOutput) ? 'text-red-400' : 'text-violet-400'
                      }`}
                    >
                      {c.toolName}
                    </code>
                    {isErrorOutput(c.toolOutput) && (
                      <span className="ml-2 text-[10px] font-semibold text-red-400 uppercase">
                        error
                      </span>
                    )}
                    {c.turn !== null && (
                      <span className="ml-2 text-[10px] text-neutral-600">turn {c.turn}</span>
                    )}
                  </td>
                  <td className="hidden md:table-cell px-5 py-3 text-xs">
                    {c.agentName ? (
                      <Link
                        href={`/logs?agent=${c.agentId}`}
                        className="text-neutral-300 hover:text-white"
                      >
                        {c.agentName}
                      </Link>
                    ) : (
                      <span className="text-neutral-600">—</span>
                    )}
                  </td>
                  <td className="hidden lg:table-cell px-5 py-3 text-xs text-neutral-400">
                    {formatDuration(c.durationMs)}
                  </td>
                  <td className="hidden lg:table-cell px-5 py-3">
                    {c.jobId ? (
                      <Link
                        href={`/jobs/${c.jobId}`}
                        className="font-mono text-xs text-neutral-500 hover:text-white"
                      >
                        {c.jobId.slice(0, 8)}
                      </Link>
                    ) : (
                      <span className="text-neutral-600">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

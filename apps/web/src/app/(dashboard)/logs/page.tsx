import Link from 'next/link';
import {
  listAgentsAction,
  listServiceLogsAction,
  listToolCallsAction,
  listToolNamesAction,
} from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import EmptyState from '@/components/ui/EmptyState';
import LogFilters from './LogFilters.tsx';
import LogsTable from './LogsTable.tsx';
import ServiceLogsPanel from './ServiceLogsPanel.tsx';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

interface PageProps {
  searchParams: Promise<{
    agent?: string;
    tool?: string;
    job?: string;
    page?: string;
    view?: string;
  }>;
}

/** Les deux onglets de la page : l'audit d'activité (tool calls) et les logs
 *  de SERVICE (runner/web) — deux choses que la page confondait par son nom. */
function ViewTabs({ active }: { active: 'activity' | 'service' }) {
  const base = 'rounded-full border px-3.5 py-1.5 text-medium-13 transition-colors';
  return (
    <div className="flex gap-2">
      <Link
        href="/logs"
        className={
          active === 'activity'
            ? `${base} border-rule bg-hover text-ink`
            : `${base} border-rule-2 text-ink-3 hover:text-ink`
        }
      >
        Activity
      </Link>
      <Link
        href="/logs?view=service"
        className={
          active === 'service'
            ? `${base} border-rule bg-hover text-ink`
            : `${base} border-rule-2 text-ink-3 hover:text-ink`
        }
      >
        Service logs
      </Link>
    </div>
  );
}

export default async function LogsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);

  if (sp.view === 'service') {
    const logsResult = await listServiceLogsAction();
    return (
      <PageShell
        title="Logs"
        subtitle="Runner and web process logs — errors, traces, and rotation archives."
        toolbar={<ViewTabs active="service" />}
      >
        {logsResult.ok ? (
          <ServiceLogsPanel initial={logsResult.data} />
        ) : (
          <div className="rounded-xl border border-err/25 bg-paper px-6 py-8 text-sm text-err">
            {logsResult.message}
          </div>
        )}
      </PageShell>
    );
  }

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
      toolbar={
        <div className="flex flex-wrap items-center gap-3">
          <ViewTabs active="activity" />
          <LogFilters agents={agents} toolNames={toolNames} />
        </div>
      }
    >
      <div className="space-y-6">
        {result.data.items.length === 0 ? (
          <EmptyState title="No tool calls yet. Send a task on the Tasks page to generate some." />
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

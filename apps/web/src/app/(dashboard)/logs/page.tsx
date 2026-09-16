import Link from 'next/link';
import {
  listActivityRunsAction,
  listAgentsAction,
  listServiceLogsAction,
  listToolNamesAction,
} from '@/lib/actions.ts';
import { runIsLive } from '@/lib/activity-runs.ts';
import PageShell from '@/components/ui/PageShell';
import EmptyState from '@/components/ui/EmptyState';
import SendTaskForm from '@/components/SendTaskForm.tsx';
import LiveRefresh from '../spaces/LiveRefresh.tsx';
import LogFilters from './LogFilters.tsx';
import RunsList from './RunsList.tsx';
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

/** Les deux onglets de la page : l'activité (les runs) et les logs de SERVICE
 *  (runner/web) — deux choses que la page confondait par son nom. */
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
    // Des RUNS, et leur compte d'appels. Aucun appel n'est lu ici : une ligne
    // dépliée va chercher les siens (voir RunRow).
    listActivityRunsAction({
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

  const runs = result.data.items;
  // Un run en cours dans la liste : la page se relit, comme le fil, pour que
  // les compteurs des lignes repliées avancent avec le travail.
  const live = runs.some((r) => runIsLive(r.status));

  return (
    <PageShell
      title="Logs"
      subtitle="Recent runs across the fleet. Open a row to see its calls."
      toolbar={
        <div className="flex flex-wrap items-center gap-3">
          <ViewTabs active="activity" />
          <LogFilters agents={agents} toolNames={toolNames} />
          <SendTaskForm agents={agents} />
        </div>
      }
    >
      <LiveRefresh live={live} />
      <div className="space-y-6">
        {runs.length === 0 ? (
          <EmptyState title="No run yet. Send a task to an agent to start one." />
        ) : (
          <RunsList runs={runs} expandedRunId={sp.job ?? null} />
        )}

        {(result.data.hasMore || page > 1) && (
          <Pagination page={page} hasMore={result.data.hasMore} sp={sp} />
        )}
      </div>
    </PageShell>
  );
}

function Pagination({
  page,
  hasMore,
  sp,
}: {
  page: number;
  hasMore: boolean;
  sp: Awaited<PageProps['searchParams']>;
}) {
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
        {hasMore ? (
          <Link
            href={`/logs?${next.toString()}`}
            className="rounded-md border border-rule-2 px-3 py-1.5 transition-colors hover:border-rule hover:text-ink"
          >
            Next
          </Link>
        ) : (
          <span className="rounded-md border border-rule px-3 py-1.5 text-ink-4">Next</span>
        )}
      </div>
    </div>
  );
}

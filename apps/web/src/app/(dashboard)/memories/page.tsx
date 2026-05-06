import Link from 'next/link';
import { listAgentsAction, listMemoriesAction } from '@/lib/actions.ts';
import MemoryActions from './MemoryActions.tsx';
import MemoryFilters from './MemoryFilters.tsx';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

const CATEGORY_COLOR: Record<string, string> = {
  preference: 'text-violet-400',
  context: 'text-neutral-400',
  outcome: 'text-emerald-400',
  learned_rule: 'text-amber-400',
};

interface PageProps {
  searchParams: Promise<{
    agent?: string;
    category?: string;
    tag?: string;
    archived?: string;
    page?: string;
  }>;
}

export default async function MemoriesPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);

  const agentsResult = await listAgentsAction();
  const memoriesResult = await listMemoriesAction({
    agentId: sp.agent || undefined,
    category: sp.category || undefined,
    tag: sp.tag || undefined,
    archived: sp.archived === '1',
    page,
    pageSize: PAGE_SIZE,
  });

  const agents = agentsResult.ok ? agentsResult.data : [];
  const data = memoriesResult.ok ? memoriesResult.data : null;

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-white">Memories</h1>
        <p className="text-sm text-neutral-500 mt-0.5">
          {data
            ? `${data.totalCount} memor${data.totalCount === 1 ? 'y' : 'ies'}`
            : 'Failed to load'}
        </p>
      </div>

      <MemoryFilters agents={agents} />

      {!memoriesResult.ok ? (
        <div className="bg-neutral-900 border border-red-900/40 rounded-xl px-6 py-8 text-sm text-red-300">
          {memoriesResult.message}
        </div>
      ) : data && data.items.length === 0 ? (
        <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-6 py-12 text-center text-neutral-600 text-sm">
          No memories match these filters. Agents save memories automatically when they call{' '}
          <code className="font-mono text-neutral-500">save_memory</code>.
        </div>
      ) : data ? (
        <>
          <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-800/60">
                  <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider">
                    Fact
                  </th>
                  <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider hidden md:table-cell">
                    Agent
                  </th>
                  <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider hidden lg:table-cell">
                    Category
                  </th>
                  <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider hidden lg:table-cell">
                    Imp
                  </th>
                  <th className="text-left px-5 py-3 text-xs text-neutral-500 font-semibold uppercase tracking-wider hidden xl:table-cell">
                    Tags
                  </th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {data.items.map((m) => (
                  <tr key={m.id} className="border-b border-neutral-800/40 last:border-0 align-top">
                    <td className="px-5 py-3">
                      <div className="text-white">{m.fact}</div>
                      <div className="text-xs text-neutral-600 mt-1">
                        {m.created_at ? new Date(m.created_at).toLocaleString() : '—'}
                        {m.access_count > 0 ? ` · accessed ${m.access_count}×` : ''}
                        {m.archived ? ' · archived' : ''}
                      </div>
                    </td>
                    <td className="hidden md:table-cell px-5 py-3 text-xs">
                      {m.agentName ? (
                        <Link
                          href={`/memories?agent=${m.agent_id}`}
                          className="text-neutral-300 hover:text-white"
                        >
                          {m.agentName}
                        </Link>
                      ) : (
                        <span className="text-neutral-600">—</span>
                      )}
                    </td>
                    <td className="hidden lg:table-cell px-5 py-3 text-xs">
                      <span className={CATEGORY_COLOR[m.category] ?? 'text-neutral-500'}>
                        {m.category}
                      </span>
                    </td>
                    <td className="hidden lg:table-cell px-5 py-3 text-xs text-neutral-400">
                      {m.importance}
                    </td>
                    <td className="hidden xl:table-cell px-5 py-3 text-xs text-neutral-500">
                      {m.skill_tags.length > 0 ? m.skill_tags.join(', ') : '—'}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <MemoryActions id={m.id} archived={m.archived} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.totalCount > PAGE_SIZE && (
            <Pagination
              page={data.page}
              hasMore={data.hasMore}
              totalCount={data.totalCount}
              pageSize={data.pageSize}
              currentSearch={sp}
            />
          )}
        </>
      ) : null}
    </div>
  );
}

interface PaginationProps {
  page: number;
  hasMore: boolean;
  totalCount: number;
  pageSize: number;
  currentSearch: Awaited<PageProps['searchParams']>;
}

function Pagination({ page, hasMore, totalCount, pageSize, currentSearch }: PaginationProps) {
  const lastPage = Math.max(1, Math.ceil(totalCount / pageSize));
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(currentSearch)) {
    if (v && k !== 'page') params.set(k, v);
  }
  const prevHref = page > 1 ? `/memories?${withPage(params, page - 1)}` : null;
  const nextHref = hasMore ? `/memories?${withPage(params, page + 1)}` : null;

  return (
    <div className="flex items-center justify-between text-xs text-neutral-500">
      <span>
        Page {page} of {lastPage}
      </span>
      <div className="flex gap-2">
        {prevHref ? (
          <Link
            href={prevHref}
            className="px-3 py-1.5 border border-neutral-800 rounded-md hover:border-neutral-700 hover:text-white"
          >
            Previous
          </Link>
        ) : (
          <span className="px-3 py-1.5 border border-neutral-900 text-neutral-700 rounded-md">
            Previous
          </span>
        )}
        {nextHref ? (
          <Link
            href={nextHref}
            className="px-3 py-1.5 border border-neutral-800 rounded-md hover:border-neutral-700 hover:text-white"
          >
            Next
          </Link>
        ) : (
          <span className="px-3 py-1.5 border border-neutral-900 text-neutral-700 rounded-md">
            Next
          </span>
        )}
      </div>
    </div>
  );
}

function withPage(params: URLSearchParams, page: number): string {
  const out = new URLSearchParams(params);
  out.set('page', String(page));
  return out.toString();
}

import Link from 'next/link';
import { listAgentsAction, listMemoriesAction } from '@/lib/actions.ts';
import AgentAvatar from '@/components/ui/AgentAvatar';
import MemoryCategoryChip from '@/components/ui/MemoryCategoryChip';
import MemoryActions from './MemoryActions.tsx';
import MemoryFilters from './MemoryFilters.tsx';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

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
    <div className="py-7">
      {/* Header ------------------------------------------------------- */}
      <div className="mb-5">
        <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.015em] text-ink">
          Memories
        </h1>
        <p className="mt-1.5 text-[13px] leading-[1.5] text-ink-3">
          {data
            ? `${data.totalCount} memor${data.totalCount === 1 ? 'y' : 'ies'} stored`
            : 'Failed to load'}
        </p>
      </div>

      {/* Filters ------------------------------------------------------- */}
      <MemoryFilters agents={agents} />

      {/* Content ------------------------------------------------------- */}
      {!memoriesResult.ok ? (
        <div className="mt-4 rounded-xl border border-warn/40 bg-warn-bg px-6 py-8 text-sm text-warn">
          {memoriesResult.message}
        </div>
      ) : data && data.items.length === 0 ? (
        <div className="mt-4 rounded-xl border border-rule-2 bg-paper px-6 py-12 text-center text-sm text-ink-4">
          No memories match these filters. Agents save memories automatically when they call{' '}
          <code className="font-mono text-ink-3">save_memory</code>.
        </div>
      ) : data ? (
        <div className="mt-4 space-y-3">
          <div className="overflow-hidden rounded-xl border border-rule-2 bg-paper">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-rule-2">
                  <th className="px-5 py-3 text-left text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">
                    Fact
                  </th>
                  <th className="hidden px-5 py-3 text-left text-[10.5px] font-semibold uppercase tracking-wider text-ink-4 md:table-cell">
                    Agent
                  </th>
                  <th className="hidden px-5 py-3 text-left text-[10.5px] font-semibold uppercase tracking-wider text-ink-4 lg:table-cell">
                    Category
                  </th>
                  <th className="hidden px-5 py-3 text-left text-[10.5px] font-semibold uppercase tracking-wider text-ink-4 lg:table-cell">
                    Imp
                  </th>
                  <th className="hidden px-5 py-3 text-left text-[10.5px] font-semibold uppercase tracking-wider text-ink-4 xl:table-cell">
                    Tags
                  </th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {data.items.map((m) => (
                  <tr
                    key={m.id}
                    className="align-top border-b border-rule-2/60 last:border-0 hover:bg-hover/50 transition-colors"
                  >
                    {/* Fact + metadata -------------------------------- */}
                    <td className="px-5 py-3.5">
                      <div className="text-[13px] leading-snug text-ink">{m.fact}</div>
                      <div className="mt-1 font-mono text-[11px] text-ink-4">
                        {m.created_at ? new Date(m.created_at).toLocaleString() : '—'}
                        {m.access_count > 0 ? ` · accessed ${m.access_count}×` : ''}
                        {m.archived ? ' · archived' : ''}
                      </div>
                    </td>

                    {/* Agent ------------------------------------------ */}
                    <td className="hidden px-5 py-3.5 md:table-cell">
                      {m.agentName ? (
                        <Link
                          href={`/memories?agent=${m.agent_id}`}
                          className="inline-flex items-center gap-2 text-[12px] text-ink-2 hover:text-ink transition-colors"
                        >
                          <AgentAvatar name={m.agentName} size="sm" />
                          {m.agentName}
                        </Link>
                      ) : (
                        <span className="text-ink-4">—</span>
                      )}
                    </td>

                    {/* Category chip ---------------------------------- */}
                    <td className="hidden px-5 py-3.5 lg:table-cell">
                      <MemoryCategoryChip category={m.category} />
                    </td>

                    {/* Importance ------------------------------------- */}
                    <td className="hidden px-5 py-3.5 font-mono text-[12px] text-ink-3 lg:table-cell">
                      {m.importance}
                    </td>

                    {/* Tags ------------------------------------------ */}
                    <td className="hidden px-5 py-3.5 text-[11px] text-ink-4 xl:table-cell">
                      {m.skill_tags.length > 0 ? m.skill_tags.join(', ') : '—'}
                    </td>

                    {/* Actions --------------------------------------- */}
                    <td className="px-5 py-3.5 text-right">
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
        </div>
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
    <div className="flex items-center justify-between text-[12px] text-ink-4">
      <span>
        Page {page} of {lastPage}
      </span>
      <div className="flex gap-2">
        {prevHref ? (
          <Link
            href={prevHref}
            className="rounded-md border border-rule-2 bg-paper px-3 py-1.5 text-ink-3 hover:border-rule hover:text-ink transition-colors"
          >
            Previous
          </Link>
        ) : (
          <span className="rounded-md border border-rule-2 px-3 py-1.5 text-ink-4 opacity-40">
            Previous
          </span>
        )}
        {nextHref ? (
          <Link
            href={nextHref}
            className="rounded-md border border-rule-2 bg-paper px-3 py-1.5 text-ink-3 hover:border-rule hover:text-ink transition-colors"
          >
            Next
          </Link>
        ) : (
          <span className="rounded-md border border-rule-2 px-3 py-1.5 text-ink-4 opacity-40">
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

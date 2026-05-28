import { listAgentsAction, listMemoriesAction } from '@/lib/actions.ts';
import MemoriesClient from './MemoriesClient.tsx';

export const dynamic = 'force-dynamic';

/**
 * MemoriesPage — server shell. Fetches the full unfiltered dataset so the
 * client component can filter without extra round-trips. The memory table
 * is scoped to the current entity, so the total volume is bounded.
 *
 * All filter state (tab, agent, search, archived toggle) lives in
 * MemoriesClient; there are no URL search params — the previous URL-param
 * approach is replaced by client state for a snappier UX.
 */
export default async function MemoriesPage() {
  const [agentsResult, memoriesResult] = await Promise.all([
    listAgentsAction(),
    listMemoriesAction({
      // Fetch a large page to cover most real-world entity datasets.
      // If an entity grows to thousands of memories, add pagination in the
      // client component at that point.
      pageSize: 200,
      archived: false,
    }),
    // Also fetch archived so the "Archived" tab works without a re-fetch.
    // We merge below.
  ]);

  const archivedResult = await listMemoriesAction({
    pageSize: 200,
    archived: true,
  });

  const agents = agentsResult.ok ? agentsResult.data : [];

  // Merge active + archived into a single list. Client-side filter by
  // m.archived. If either fetch fails, fall back to an empty list.
  const activeItems = memoriesResult.ok ? memoriesResult.data.items : [];
  const archivedItems = archivedResult.ok ? archivedResult.data.items : [];
  const allItems = [...activeItems, ...archivedItems];
  const totalCount = memoriesResult.ok ? memoriesResult.data.totalCount : 0;

  return <MemoriesClient initialItems={allItems} agents={agents} totalCount={totalCount} />;
}

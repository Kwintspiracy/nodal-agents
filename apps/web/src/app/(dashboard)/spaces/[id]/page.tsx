import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSpaceConversationAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import ConversationFeedView from '../ConversationFeedView.tsx';
import LiveRefresh from '../LiveRefresh.tsx';
import { formatCost, formatTokens } from '../format.ts';
import { truncate } from '@/lib/format-time';

// Force dynamic — the feed is read per request, and re-read while the job runs.
export const dynamic = 'force-dynamic';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function statusVariant(status: string | null): StatusVariant {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'cancelled') return 'warn';
  if (status === 'processing' || status === 'pending' || (status?.startsWith('awaiting') ?? false))
    return 'run';
  return 'idle';
}

export default async function SpaceConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getSpaceConversationAction(id);
  if (!result.ok) {
    if (result.code === 'not_found') notFound();
    return (
      <PageShell title="Space">
        <Link href="/spaces" className="text-xs text-ink-3 hover:text-ink-2">
          ← Spaces
        </Link>
        <p className="mt-4 text-sm text-err">{result.message}</p>
      </PageShell>
    );
  }

  const { job, feed } = result.data;
  const live = !TERMINAL.has(job.status ?? '');
  const firstLine = job.task.split('\n')[0] ?? job.task;
  const subtitle = [
    job.agentName,
    `${feed.totals.turns} ${feed.totals.turns === 1 ? 'turn' : 'turns'}`,
    `${formatTokens(feed.totals.inputTokens + feed.totals.outputTokens)} tokens`,
    feed.totals.costUsd !== null ? formatCost(feed.totals.costUsd) : null,
  ]
    .filter((x): x is string => typeof x === 'string' && x !== '')
    .join(' · ');

  return (
    <PageShell
      title={truncate(firstLine, 90)}
      subtitle={subtitle}
      toolbar={
        <div className="flex items-center gap-3">
          <Link href="/spaces" className="text-xs text-ink-3 hover:text-ink-2">
            ← Spaces
          </Link>
          <StatusPill variant={statusVariant(job.status)} />
          {job.parentJobId && (
            <Link
              href={`/spaces/${job.parentJobId}`}
              className="text-xs text-ink-3 hover:text-ink-2"
            >
              ↑ parent task
            </Link>
          )}
          <span className="ml-auto text-mono-11 text-ink-4">{job.id}</span>
        </div>
      }
    >
      <LiveRefresh live={live} />
      <ConversationFeedView feed={feed} />
    </PageShell>
  );
}

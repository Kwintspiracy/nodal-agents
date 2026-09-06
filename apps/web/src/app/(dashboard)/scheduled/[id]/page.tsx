// /scheduled/[id] — LE FIL D'UN RUN (P2-P4, déménagé ici par P8).
//
// Cette page était /spaces/[id] tant que Spaces listait des jobs. Spaces liste
// maintenant des PROJETS, et /spaces/[id] est la page d'un projet : le fil d'un
// TRAVAIL n'a plus qu'un point d'entrée, celui d'un run d'automatisation qui
// « ouvre son fil » (garde de P9). Rien d'autre n'a changé — les mêmes cartes,
// la même preuve, la même barre d'état.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSpaceConversationAction } from '@/lib/actions.ts';
import PageShell from '@/components/ui/PageShell';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import ConversationFeedView from '@/app/(dashboard)/spaces/ConversationFeedView.tsx';
import LiveRefresh from '@/app/(dashboard)/spaces/LiveRefresh.tsx';
import DeliveriesCard from '@/app/(dashboard)/spaces/DeliveriesCard.tsx';
import StatusBar from '@/app/(dashboard)/spaces/StatusBar.tsx';
import VerificationSection from '@/app/(dashboard)/code/[id]/VerificationSection.tsx';
import { formatCost, formatTokens } from '@/app/(dashboard)/spaces/format.ts';
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

export default async function ScheduledRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getSpaceConversationAction(id);
  if (!result.ok) {
    if (result.code === 'not_found') notFound();
    return (
      <PageShell title="Run">
        <Link href="/scheduled" className="text-xs text-ink-3 hover:text-ink-2">
          ← Scheduled
        </Link>
        <p className="mt-4 text-sm text-err">{result.message}</p>
      </PageShell>
    );
  }

  const { job, feed, verification, cost, deliveries } = result.data;
  const lastProof = verification.sequences.at(-1) ?? null;
  const pendingDeliveries = deliveries.filter(
    (d) => d.outcome === 'prepared' || d.outcome === 'attempted',
  ).length;
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
          <Link href="/scheduled" className="text-xs text-ink-3 hover:text-ink-2">
            ← Scheduled
          </Link>
          <StatusPill variant={statusVariant(job.status)} />
          {job.parentJobId && (
            <Link
              href={`/scheduled/${job.parentJobId}`}
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
      {/* P3 — la preuve, la même carte que le détail Code (elle n'est jamais
          vide : elle dit « pas encore », « hors vérification », « rien à
          configurer »), puis la file d'envoi. */}
      <div className="mx-auto mt-8 max-w-[840px] space-y-6">
        <VerificationSection
          sequences={verification.sequences}
          skippedSurfaces={verification.skippedSurfaces}
          unconfigured={verification.unconfigured}
          stage={job.status ?? 'pending'}
          live={live}
        />
        <DeliveriesCard deliveries={deliveries} />
      </div>
      {/* P4 — la barre d'état, permanente en bas de la page ; ses jetons et son
          coût ouvrent le panneau « What this work cost ». */}
      <StatusBar
        cost={cost}
        proofVerdict={lastProof?.verdict ?? null}
        proofSequences={verification.sequences.length}
        pendingDeliveries={pendingDeliveries}
        live={live}
      />
    </PageShell>
  );
}

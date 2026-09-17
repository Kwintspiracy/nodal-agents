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
import WorkBar from '@/app/(dashboard)/spaces/WorkBar.tsx';
import ConversationFeedView from '@/app/(dashboard)/spaces/ConversationFeedView.tsx';
import LiveRefresh from '@/app/(dashboard)/spaces/LiveRefresh.tsx';
import DeliveriesCard from '@/app/(dashboard)/spaces/DeliveriesCard.tsx';
import StatusBar from '@/app/(dashboard)/spaces/StatusBar.tsx';
import ThreadScreen from '@/app/(dashboard)/chat/[id]/ThreadScreen.tsx';
import ThreadHeader from '@/app/(dashboard)/chat/[id]/ThreadHeader.tsx';
import VerificationSection from '@/app/(dashboard)/code/[id]/VerificationSection.tsx';
import { threadAgents, threadSubtitle } from '@/app/(dashboard)/spaces/format.ts';
import { plainText } from '@/components/Markdown.tsx';
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
  const showVerification =
    verification.sequences.length > 0 ||
    verification.unconfigured.length > 0 ||
    verification.skippedSurfaces.length > 0 ||
    live;
  const firstLine = plainText(job.task);
  // P2bis — le fil d'un run n'a pas de projet : son « lieu » est le run
  // lui-même, dit par l'agent qui l'a porté. Pas de bouton « Files » : sans
  // projet il n'y a pas de dossier à ouvrir.
  //
  // #135 — le même en-tête que les deux autres écrans de fil : l'agent devant,
  // sa première ligne derrière, et dessous ce que c'est et depuis quand. Le nom
  // de l'agent quitte le sous-titre, où il doublait l'avatar.
  const agentName = job.agentName ?? '';
  const task = truncate(firstLine, 60);
  return (
    <PageShell
      fill
      toolbarBleed
      header={
        <ThreadHeader
          avatarName={agentName}
          avatarUrl={job.agentAvatarUrl}
          title={agentName !== '' ? `${agentName} · ${task}` : task}
          subtitle={threadSubtitle('run', job.createdAt)}
        />
      }
      toolbar={
        <WorkBar
          back={{ label: 'Back to scheduled', href: '/scheduled' }}
          agents={threadAgents(feed.items)}
          status={<StatusPill variant={statusVariant(job.status)} />}
          proofVerdict={lastProof?.verdict ?? null}
        />
      }
    >
      <ThreadScreen
        statusBar={
          // P4 — la barre d'état, ancrée tout en bas de l'écran ; ses jetons et
          // son coût ouvrent le panneau « What this work cost ».
          <StatusBar
            cost={cost}
            proofVerdict={lastProof?.verdict ?? null}
            proofSequences={verification.sequences.length}
            pendingDeliveries={pendingDeliveries}
            live={live}
          />
        }
      >
        {job.parentJobId && (
          <p className="mx-auto mb-4 max-w-[760px]">
            <Link
              href={`/scheduled/${job.parentJobId}`}
              className="text-mono-11 text-ink-4 hover:text-ink-2"
            >
              ↑ parent task
            </Link>
          </p>
        )}
        <LiveRefresh live={live} />
        <ConversationFeedView feed={feed} deliverables={verification.deliverables} />
        {/* P3 — la preuve, la même carte que le détail Code (elle n'est jamais
          vide : elle dit « pas encore », « hors vérification », « rien à
          configurer »), puis la file d'envoi. */}
        <div className="mx-auto mt-8 max-w-[760px] space-y-6">
          {showVerification && (
            <VerificationSection
              sequences={verification.sequences}
              skippedSurfaces={verification.skippedSurfaces}
              unconfigured={verification.unconfigured}
              stage={job.status ?? 'pending'}
              live={live}
            />
          )}
          <DeliveriesCard deliveries={deliveries} />
        </div>
      </ThreadScreen>
    </PageShell>
  );
}

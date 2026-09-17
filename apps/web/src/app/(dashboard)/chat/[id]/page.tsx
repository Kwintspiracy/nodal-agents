// /chat/[id] — LE FIL d'une conversation (P7).
//
// Le même fil que la page d'un espace (P2), les mêmes cartes, la même preuve
// (P3) et la même barre d'état (P4) : une conversation et un travail se lisent
// de la même façon, parce que c'est la même matière — des tours, des actions,
// un coût. Ce que cette page ajoute, c'est la saisie en bas quand la
// conversation est celle du dashboard.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import PageShell from '@/components/ui/PageShell';
import StatusPill from '@/components/ui/StatusPill';
import WorkBar from '@/app/(dashboard)/spaces/WorkBar.tsx';
import ConversationFeedView from '@/app/(dashboard)/spaces/ConversationFeedView.tsx';
import LiveRefresh from '@/app/(dashboard)/spaces/LiveRefresh.tsx';
import StatusBar from '@/app/(dashboard)/spaces/StatusBar.tsx';
import { originLabel, threadAgents, threadSubtitle } from '@/app/(dashboard)/spaces/format.ts';
import { getConversationThreadAction } from '@/lib/conversation-actions.ts';
import { plainText } from '@/components/Markdown.tsx';
import { truncate } from '@/lib/format-time';
import ThreadComposer from '../ThreadComposer.tsx';
import ThreadScreen from './ThreadScreen.tsx';
import ThreadHeader from './ThreadHeader.tsx';

// Force dynamic — le fil est relu à chaque requête, et pendant qu'un travail court.
export const dynamic = 'force-dynamic';

export default async function ChatThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getConversationThreadAction(id);
  if (!result.ok) {
    if (result.code === 'not_found') notFound();
    return (
      <PageShell title="Conversation">
        <Link href="/chat" className="text-xs text-ink-3 hover:text-ink-2">
          ← Chat
        </Link>
        <p className="mt-4 text-sm text-err">{result.message}</p>
      </PageShell>
    );
  }

  const { conversation, feed, verification, cost, deliveries, live, canReply } = result.data;
  const lastProof = verification.sequences.at(-1) ?? null;
  const pendingDeliveries = deliveries.filter(
    (d) => d.outcome === 'prepared' || d.outcome === 'attempted',
  ).length;
  // Le titre : celui que porte la conversation, sinon sa première demande —
  // jamais un identifiant. « Untitled » n'apparaît que si les deux manquent.
  const firstRequest = feed.items.find((i) => i.kind === 'request');
  // `plainText` avant de couper : un titre qui commence par « ## **PRD** »
  // s'affichait avec ses dièses et ses astérisques.
  const title =
    conversation.title !== ''
      ? truncate(plainText(conversation.title), 60)
      : firstRequest
        ? truncate(plainText(firstRequest.text), 60)
        : 'Untitled';

  const origin = originLabel({
    channel: conversation.channel,
    scheduleName: null,
    chatId: conversation.chatId,
  });
  const project = conversation.currentProject;
  // #135 — l'en-tête dessiné : QUI parle et DE QUOI, puis d'où vient la
  // demande et depuis quand. Le nom du projet n'est plus le titre de la page :
  // la maquette met l'agent devant, et le dossier reste à un clic derrière le
  // bouton « Files » de la barre. Sans agent connu, le titre est le sujet seul
  // — jamais un point médian orphelin.
  const agentName = conversation.agentName ?? '';
  const headerTitle = agentName !== '' ? `${agentName} · ${title}` : title;

  return (
    <PageShell
      fill
      toolbarBleed
      header={
        <ThreadHeader
          avatarName={agentName}
          avatarUrl={conversation.agentAvatarUrl}
          title={headerTitle}
          subtitle={threadSubtitle(origin, conversation.createdAt)}
        />
      }
      toolbar={
        <WorkBar
          back={{ label: 'Back to chat', href: '/chat' }}
          agents={threadAgents(feed.items)}
          status={<StatusPill variant={live ? 'run' : 'idle'} />}
          proofVerdict={lastProof?.verdict ?? null}
          filesHref={project ? `/spaces/${project.id}/files` : null}
        />
      }
    >
      <ThreadScreen
        composer={
          canReply ? (
            <ThreadComposer conversationId={conversation.id} agentName={conversation.agentName} />
          ) : (
            <p className="mx-auto max-w-[760px] text-body-13 text-ink-4">
              This conversation lives in {origin.replace(/^via /, '')}. Reply from there.
            </p>
          )
        }
        statusBar={
          // P4 — la barre d'état, ancrée tout en bas de l'écran.
          <StatusBar
            cost={cost}
            proofVerdict={lastProof?.verdict ?? null}
            proofSequences={verification.sequences.length}
            pendingDeliveries={pendingDeliveries}
            live={live}
          />
        }
      >
        <LiveRefresh live={live} />
        <ConversationFeedView feed={feed} deliverables={verification.deliverables} />
        {/* P2bis — la preuve et la file d'envoi ne sont plus EN BAS de la page.
            La preuve vit dans le récapitulatif de livraison du travail qui l'a
            fait tourner (« Checks »), et la file d'envoi dans la barre d'état,
            qui compte déjà les messages en attente. Une section de plus, trois
            écrans sous le tour qu'elle décrivait, ne se lisait jamais. */}
      </ThreadScreen>
    </PageShell>
  );
}

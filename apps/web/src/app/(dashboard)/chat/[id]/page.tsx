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
import { originLabel, threadAgents } from '@/app/(dashboard)/spaces/format.ts';
import { getConversationThreadAction } from '@/lib/conversation-actions.ts';
import { getAgentModelChoicesAction } from '@/lib/actions.ts';
import { plainText } from '@/components/Markdown.tsx';
import { truncate } from '@/lib/format-time';
import ThreadComposer from '../ThreadComposer.tsx';
import ThreadScreen from './ThreadScreen.tsx';

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
  // #138 — ce que les trois listes du composeur montrent : la clé de l'agent,
  // son modèle, son effort, et les clés actives de l'espace. Un agent disparu
  // ne fait pas rougir la page — les listes se taisent.
  const choices = canReply ? await getAgentModelChoicesAction(conversation.agentId) : null;
  const modelChoices = choices?.ok ? choices.data : null;
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
  // P2bis — l'en-tête d'un fil dit le LIEU du travail : le projet courant et
  // son dossier quand il y en a un, sinon de quoi parle la conversation et
  // d'où elle vient. Les compteurs (tours, jetons, coût) sont dans la barre
  // d'état, en bas, où ils étaient déjà.
  const project = conversation.currentProject;

  return (
    <PageShell
      fill
      // Le design system : le NOM est le titre de la page, le chemin son
      // sous-titre. Ce qui reste (retour, agents, dossier, état) va dans la
      // barre sous l'en-tête, comme « Back to agents » sur Edit agent
      // (Quentin, 07/09).
      title={project ? project.name : title}
      subtitle={project ? project.path : origin}
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
            <ThreadComposer
              conversationId={conversation.id}
              agentName={conversation.agentName}
              agentId={conversation.agentId}
              llmKeyId={modelChoices?.llmKeyId ?? null}
              model={modelChoices?.model ?? null}
              reasoningEffort={modelChoices?.reasoningEffort ?? null}
              llmKeys={modelChoices?.llmKeys ?? []}
            />
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

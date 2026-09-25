// /chat/[id] — LE FIL d'une conversation (P7).
//
// Le même fil que la page d'un espace (P2), les mêmes cartes, la même preuve
// (P3) et la même barre d'état (P4) : une conversation et un travail se lisent
// de la même façon, parce que c'est la même matière — des tours, des actions,
// un coût. Ce que cette page ajoute, c'est la saisie en bas quand la
// conversation est celle du dashboard.

import { notFound } from 'next/navigation';
import PageShell from '@/components/ui/PageShell';
import StatusPill from '@/components/ui/StatusPill';
import StopRunButton from '@/components/ui/StopRunButton';
import { canStopRun } from '@/lib/job-live.ts';
import ThreadWorkBar from '@/app/(dashboard)/spaces/ThreadWorkBar.tsx';
import ConversationFeedView from '@/app/(dashboard)/spaces/ConversationFeedView.tsx';
import LiveRefresh from '@/app/(dashboard)/spaces/LiveRefresh.tsx';
import StatusBar from '@/app/(dashboard)/spaces/StatusBar.tsx';
import { originLabel, threadAgents, threadSubtitle } from '@/app/(dashboard)/spaces/format.ts';
import { getConversationThreadAction } from '@/lib/conversation-actions.ts';
import { getAgentModelChoicesAction } from '@/lib/actions.ts';
import { DEFAULT_FEED_DENSITY } from '@/lib/feed-density.ts';
import { plainText } from '@/components/Markdown.tsx';
import { truncate } from '@/lib/format-time';
import ThreadComposer from '../ThreadComposer.tsx';
import ThreadScreen from './ThreadScreen.tsx';
import ThreadHeader from './ThreadHeader.tsx';
import ConversationApprovals from './ConversationApprovals.tsx';
import PendingTurn, { PendingTurnProvider } from '../PendingTurn.tsx';
import { feedAwaitsReply, feedRequests } from '../feed-requests.ts';

// Force dynamic — le fil est relu à chaque requête, et pendant qu'un travail court.
export const dynamic = 'force-dynamic';

export default async function ChatThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getConversationThreadAction(id);
  if (!result.ok) {
    if (result.code === 'not_found') notFound();
    return (
      <PageShell title="Conversation">
        <p className="text-sm text-err">{result.message}</p>
      </PageShell>
    );
  }

  const { conversation, feed, verification, cost, deliveries, live, liveJobs, canReply } =
    result.data;
  const lastProof = verification.sequences.at(-1) ?? null;
  // #138 — ce que les trois listes du composeur montrent : la clé de l'agent,
  // son modèle, son effort, et les clés actives de l'espace. Un agent disparu
  // ne fait pas rougir la page — les listes se taisent.
  const choices = canReply ? await getAgentModelChoicesAction(conversation.agentId) : null;
  const modelChoices = choices?.ok ? choices.data : null;
  // Un fil s'ouvre replié, chaque tour se déplie à la main : le réglage de
  // densité par personne a été retiré (Quentin, 22/09).
  const density = DEFAULT_FEED_DENSITY;
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
      // #237 — un fil remplit le cadre : sa saisie tient le bas de l'ÉCRAN, et
      // ses blocs vont d'un bord à l'autre. La borne de largeur du mode pleine
      // hauteur ne vaut pas pour lui.
      fluid
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
        <ThreadWorkBar
          // #242 — la barre ne porte plus de retour. Elle a longtemps ramené
          // dans le DOSSIER du fil, puis au projet quand le fil y était ancré ;
          // Quentin a fait retirer les retours partout le soir du 19/09. Il ne
          // reste que ce que le fil DIT de lui-même.
          agents={threadAgents(feed.items)}
          status={<StatusPill variant={live ? 'run' : 'idle'} />}
          proofVerdict={lastProof?.verdict ?? null}
          filesHref={project ? `/spaces/${project.id}/files` : null}
        />
      }
      footer={
        // P4 — la barre d'état, ancrée tout en bas de l'écran, PLEINE LARGEUR
        // comme l'en-tête : hors de la colonne du fil (Quentin, 20/09).
        <StatusBar
          cost={cost}
          proofVerdict={lastProof?.verdict ?? null}
          proofSequences={verification.sequences.length}
          pendingDeliveries={pendingDeliveries}
          live={live}
        />
      }
    >
      {/* Le message envoyé paraît TOUT DE SUITE dans le fil, avec l'agent qui
          réfléchit, avant que la réponse arrive (Quentin, 18/09). Le porteur
          connaît les demandes que le serveur a rendues : dès que la sienne y
          est, la copie s'efface au profit du vrai tour. */}
      <PendingTurnProvider
        requests={feedRequests(feed.items)}
        awaitingReply={feedAwaitsReply(feed.items)}
      >
        <ThreadScreen
          // LA COLONNE DU FIL, 760 px centrés — la boîte de
          // `ConversationFeedView`. Le bouton tombe sur le bord droit des
          // messages, pas sur celui de l'écran.
          actionsBox="mx-auto max-w-[760px]"
          // ARRÊTER LE TOUR QUI COURT (#252). Un seul bouton, pour le travail
          // de TÊTE : annuler la tête annule ses délégués, et un bouton par
          // travail ferait une rangée qui s'allonge pendant qu'on la regarde.
          // Le plus récent — c'est celui dont on attend la réponse.
          actions={(() => {
            // Le plus récent des travaux vivants — c'est celui dont on attend la
            // réponse. `canStopRun` tranche une seconde fois parce que
            // `liveJobs` dit « non terminé » et que le bouton, lui, exige un
            // statut VIVANT connu : les deux listes se rejoignent aujourd'hui,
            // et rien ne garantit qu'elles le feront toujours.
            const dernier = liveJobs.at(-1);
            if (dernier === undefined || !canStopRun(dernier.status)) return null;
            return <StopRunButton jobId={dernier.id} status={dernier.status} />;
          })()}
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
                requireTools={modelChoices?.requireTools ?? false}
              />
            ) : (
              <p className="mx-auto max-w-[760px] text-body-13 text-ink-4">
                This conversation lives in {origin.replace(/^via /, '')}. Reply from there.
              </p>
            )
          }
        >
          <LiveRefresh live={live} />
          <ConversationFeedView
            feed={feed}
            deliverables={verification.deliverables}
            density={density}
          />
          {/* Ce que les travaux de cette conversation attendent de la personne,
              répondu ICI, sans passer par la page Approvals (#469). */}
          {/* Keyed by the conversation: moving to another one starts from an
              empty list, never the previous conversation's cards (review of
              PR #482). */}
          <ConversationApprovals key={conversation.id} conversationId={conversation.id} />
          <PendingTurn
            agentName={conversation.agentName ?? 'Agent'}
            agentAvatarUrl={conversation.agentAvatarUrl}
          />
          {/* P2bis — la preuve et la file d'envoi ne sont plus EN BAS de la page.
            La preuve vit dans le récapitulatif de livraison du travail qui l'a
            fait tourner (« Checks »), et la file d'envoi dans la barre d'état,
            qui compte déjà les messages en attente. Une section de plus, trois
            écrans sous le tour qu'elle décrivait, ne se lisait jamais. */}
        </ThreadScreen>
      </PendingTurnProvider>
    </PageShell>
  );
}

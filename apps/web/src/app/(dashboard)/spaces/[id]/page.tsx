// /spaces/[id] — LA PAGE D'UN PROJET : sa conversation (P8, refaite le 07/09).
//
// Ouvrir un projet, c'est atterrir dans le fil de SA conversation, la saisie
// collée en bas — exactement comme /chat/[id]. Quentin, 07/09 : « quand
// j'ouvre mon projet, je veux atterrir dans le feed de la conversation
// directement » ; « ce que je vois, c'est des réglages de mon projet ». Le
// dossier, ses fichiers, sa preuve et les autres conversations sont donc sur
// /spaces/[id]/files, derrière le bouton « Files » de l'en-tête — pas empilés
// au-dessus du fil.
//
// La page du FIL D'UN JOB n'est pas ici : /scheduled/[id] pour un run
// d'automatisation, /chat/[id] pour tout le reste.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import PageShell from '@/components/ui/PageShell';
import StatusPill from '@/components/ui/StatusPill';
import { getProjectThreadPageAction } from '@/lib/project-actions.ts';
import { getConversationThreadAction } from '@/lib/conversation-actions.ts';
import { getAgentModelChoicesAction } from '@/lib/actions.ts';
import { composerPresentation, projectLanding } from '@/lib/project-landing.ts';
import { originLabel } from '../format.ts';
import WorkBar from '../WorkBar.tsx';
import { threadAgents } from '../format.ts';
import ProjectThread from '../ProjectThread.tsx';
import StatusBar from '../StatusBar.tsx';

// Force dynamic — le projet et son fil sont relus à chaque requête.
export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Le chargeur LÉGER : ni lecture du dossier, ni preuve — la page les
  // payait à chaque ouverture et à chaque rafraîchissement sans les montrer
  // (revue Codex, passe 60). Ils vivent sur /spaces/[id]/files.
  const result = await getProjectThreadPageAction(id);
  if (!result.ok) {
    if (result.code === 'not_found') notFound();
    return (
      <PageShell title="Project">
        <Link href="/spaces" className="text-xs text-ink-3 hover:text-ink-2">
          ← Spaces
        </Link>
        <p className="mt-4 text-sm text-err">{result.message}</p>
      </PageShell>
    );
  }

  const { project, conversations, projectConversationId, rootAgent } = result.data;
  const landing = projectLanding(conversations, projectConversationId);

  // Le fil de la conversation du projet — la MÊME lecture que /chat/[id] (P7).
  const thread =
    landing === null ? null : await getConversationThreadAction(landing.conversationId);
  const view = thread !== null && thread.ok ? thread.data : null;
  const lastProof = view?.verification.sequences.at(-1) ?? null;
  const pendingDeliveries =
    view?.deliveries.filter((d) => d.outcome === 'prepared' || d.outcome === 'attempted').length ??
    0;

  // Ce que la saisie dit d'elle-même (revue Codex, passes 60-61) : à qui elle
  // écrit VRAIMENT — l'agent du fil prolongé, ou le ROOT à qui
  // `createProjectConversationAction` attribue une conversation créée —, ce
  // qu'elle va faire si un fil d'un autre canal est affiché (dit AVANT
  // l'envoi), ou pourquoi elle n'est pas là (pas de ROOT). Pur et testé.
  const composer = composerPresentation({
    continues: landing !== null && landing.composerConversationId !== null,
    threadAgentName: view?.conversation.agentName ?? null,
    threadOrigin:
      view !== null
        ? originLabel({
            channel: view.conversation.channel,
            scheduleName: null,
            chatId: view.conversation.chatId,
          })
        : null,
    rootAgentName: rootAgent?.name ?? null,
  });

  // #138 — les listes règlent l'agent à qui la saisie ÉCRIT : celui du fil
  // prolongé, ou le ROOT qui recevra la conversation créée. Sans agent (un
  // projet sans ROOT), il n'y a rien à régler et elles ne s'affichent pas.
  const composerAgentId =
    landing !== null && landing.composerConversationId !== null
      ? (view?.conversation.agentId ?? null)
      : (rootAgent?.id ?? null);
  const choices = composerAgentId ? await getAgentModelChoicesAction(composerAgentId) : null;
  const modelChoices = choices?.ok ? choices.data : null;

  return (
    <PageShell
      fill
      title={project.name}
      subtitle={project.path}
      toolbar={
        <WorkBar
          back={{ label: 'Back to spaces', href: '/spaces' }}
          agents={view !== null ? threadAgents(view.feed.items) : []}
          {...(view !== null
            ? { status: <StatusPill variant={view.live ? 'run' : 'idle'} /> }
            : {})}
          proofVerdict={lastProof?.verdict ?? null}
          filesHref={`/spaces/${project.id}/files`}
        />
      }
    >
      {/* Le fil et la saisie : un échec de lecture y est DIT, et retire la
          saisie (revue passe 30, constat 1). La saisie prolonge la conversation
          du projet quand on peut y répondre depuis le web ; sinon (un fil
          Telegram qu'on lit ici) le premier envoi crée celle du projet. */}
      <ProjectThread
        projectId={project.id}
        conversationId={landing?.composerConversationId ?? null}
        thread={thread}
        composer={composer}
        agentId={composerAgentId}
        llmKeyId={modelChoices?.llmKeyId ?? null}
        model={modelChoices?.model ?? null}
        reasoningEffort={modelChoices?.reasoningEffort ?? null}
        llmKeys={modelChoices?.llmKeys ?? []}
        {...(view !== null
          ? {
              // P4 — la barre d'état, ancrée tout en bas de l'écran.
              statusBar: (
                <StatusBar
                  cost={view.cost}
                  proofVerdict={lastProof?.verdict ?? null}
                  proofSequences={view.verification.sequences.length}
                  pendingDeliveries={pendingDeliveries}
                  live={view.live}
                />
              ),
            }
          : {})}
      />
    </PageShell>
  );
}

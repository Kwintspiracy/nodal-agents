// NewConversationScreen — un fil qui n'a pas encore commencé (#248, planche
// « #146 A run is not a chat », cadre `398:3917` « new conversation »).
//
// Ce n'est PAS un autre écran : c'est l'état vide de l'écran de fil, et il en
// porte toute la charpente — le même en-tête (`ThreadHeader`), la même barre de
// travail (`WorkBar`, règle #242 : le retour dedans, les actions sur la rangée
// du dessous), la même saisie à 760 px, la même barre d'état. Ce qui change est
// ce qu'il y a AU MILIEU : rien à lire, donc la ligne d'accueil et la saisie,
// centrées dans le vide, comme la planche les dessine. Dès le premier message
// envoyé, l'écran s'en va sur `/chat/<id>` et le fil se comporte comme avant.
//
// L'en-tête ne dit pas quand le fil a commencé : il n'a pas commencé.
// `threadSubtitle(origin, null)` laisse donc tomber ce morceau plutôt que de
// dater une conversation qui n'existe pas (invariant #4). La planche montre
// « started today 14:01 » ; c'est un fil déjà né qu'elle dessine.

import Link from 'next/link';
import PageShell from '@/components/ui/PageShell';
import StatusPill from '@/components/ui/StatusPill';
import ThreadHeader from './[id]/ThreadHeader.tsx';
import WorkBar from '@/app/(dashboard)/spaces/WorkBar.tsx';
import StatusBar from '@/app/(dashboard)/spaces/StatusBar.tsx';
import { originLabel, threadSubtitle } from '@/app/(dashboard)/spaces/format.ts';
import { EMPTY_SPACE_COST } from '@/lib/space-cost.ts';
import { threadBackLink } from '@/lib/back-links.ts';
import { DEFAULT_FEED_DENSITY, type FeedDensity } from '@/lib/feed-density.ts';
import NewConversationBody from './NewConversationBody.tsx';
import NewConversationComposer from './NewConversationComposer.tsx';
import { PendingTurnProvider } from './PendingTurn.tsx';
import type { ComposerLlmKey } from './ModelEffortChip.tsx';
import { welcomeLine } from './welcome-line.ts';

/**
 * Sans ROOT, il n'y a pas de saisie : toute création échouerait, et un champ
 * « What are we doing today? » qui refuserait à l'envoi mentirait (inv. #4).
 * Un mot à la place, et le geste qui débloque.
 *
 * Le ROOT ne se DÉSIGNE pas à la main : il naît avec le premier orchestrateur
 * créé, et c'est vers /agents qu'il faut aller — « Designate one in Settings »
 * menait à une action qui n'existe pas (revue Codex, passe 62).
 *
 * Ces deux phrases venaient de `lib/project-landing.ts`, qui portait la même
 * règle pour la page d'un projet sans conversation. Ce module est parti avec
 * #226 (« A project opens on its activity ») : la page d'un projet n'est plus
 * un fil, et plus personne d'autre n'avait besoin de la règle. Elle vit donc
 * ici, à son seul point d'usage, plutôt que dans un module à un client.
 */
const NO_ROOT_MESSAGE = 'No ROOT agent yet. Create an orchestrator agent to write here:';
const NO_ROOT_ACTION = {
  label: 'the first one you create becomes this workspace’s ROOT.',
  href: '/agents',
} as const;

export default function NewConversationScreen({
  accountName,
  root,
  project = null,
  density = DEFAULT_FEED_DENSITY,
  llmKeyId = null,
  model = null,
  reasoningEffort = null,
  llmKeys = [],
  requireTools = false,
}: {
  /** Le nom de la personne, ou `null` — la ligne d'accueil n'en invente pas. */
  accountName: string | null;
  /** Le ROOT : celui qui recevra la conversation. `null` : aucun désigné. */
  root: { id: string; name: string; avatarUrl: string | null } | null;
  /** Le projet porté par l'écran, quand on vient du dossier d'un projet. */
  project?: { id: string; name: string } | null;
  /** #132 — la densité de lecture de la personne, portée par la barre. */
  density?: FeedDensity;
  /** #138 — les trois listes « provider / modèle / effort » du ROOT. */
  llmKeyId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  llmKeys?: ComposerLlmKey[];
  requireTools?: boolean;
}) {
  const agentName = root?.name ?? '';
  // « <agent> · Untitled » : le fil n'a pas de sujet tant que rien n'est dit.
  // Le nom vient du ROOT lu en base, jamais d'ici (invariant #1).
  const headerTitle = agentName !== '' ? `${agentName} · Untitled` : 'Untitled';
  const origin = originLabel({ channel: 'dashboard', scheduleName: null, chatId: null });

  return (
    <PageShell
      fill
      toolbarBleed
      header={
        <ThreadHeader
          avatarName={agentName}
          avatarUrl={root?.avatarUrl ?? null}
          title={headerTitle}
          subtitle={threadSubtitle(origin, null)}
        />
      }
      toolbar={
        <WorkBar
          back={threadBackLink('dashboard')}
          // Personne n'a encore travaillé : pas de pile de visages, et aucune
          // preuve. Les dire vides serait inventer un passé à ce fil.
          agents={[]}
          status={<StatusPill variant="idle" />}
          proofVerdict={null}
          filesHref={project !== null ? `/spaces/${project.id}/files` : null}
          density={density}
        />
      }
    >
      {/* Pas de `ThreadScreen` ici, et c'est le seul écart avec un fil commencé :
          `ThreadScreen` colle la saisie EN BAS, sous une zone qui défile, parce
          qu'un fil se lit par sa fin. La planche centre l'accueil ET la saisie
          dans le vide — il n'y a rien à faire défiler. La charpente commune
          reste `PageShell fill` : en-tête, barre de travail, barre d'état.

          Le porteur des envois en cours est le MÊME que celui des deux autres
          écrans de fil : le message part et paraît TOUT DE SUITE, avec l'agent
          qui réfléchit, le temps que la réponse vienne et que l'écran s'en
          aille sur `/chat/<id>`. Son fil rendu est vide — il n'y en a pas
          encore — donc aucune copie ne s'efface ici : c'est la navigation qui
          passe la main au vrai fil. */}
      <PendingTurnProvider requests={[]} awaitingReply={false}>
        <NewConversationBody
          greeting={welcomeLine(accountName)}
          agentName={root?.name ?? 'Agent'}
          agentAvatarUrl={root?.avatarUrl ?? null}
          composer={
            root === null ? (
              <p className="mx-auto max-w-[760px] text-center text-body-13 text-ink-4">
                {NO_ROOT_MESSAGE}{' '}
                <Link
                  href={NO_ROOT_ACTION.href}
                  className="font-medium text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink-3"
                >
                  {NO_ROOT_ACTION.label}
                </Link>
              </p>
            ) : (
              <NewConversationComposer
                projectId={project?.id ?? null}
                agentName={root?.name ?? null}
                agentId={root?.id ?? null}
                llmKeyId={llmKeyId}
                model={model}
                reasoningEffort={reasoningEffort}
                llmKeys={llmKeys}
                requireTools={requireTools}
              />
            )
          }
        />
      </PendingTurnProvider>
      <StatusBar
        cost={EMPTY_SPACE_COST}
        proofVerdict={null}
        proofSequences={0}
        pendingDeliveries={0}
        live={false}
      />
    </PageShell>
  );
}

// ProjectThread — le bas de la page d'un projet (P8) : le fil de sa
// conversation, et la saisie qui le prolonge.
//
// Trois cas, et un seul mot juste pour chacun (revue passe 30, constat 1) :
//   - pas encore de conversation → « Nothing said here yet », et on peut écrire
//     (le premier envoi la crée) ;
//   - le fil est là → on le dessine, et on peut écrire ;
//   - le fil n'a PAS pu être lu → on dit l'erreur, et on RETIRE la saisie.
//
// Ce troisième cas est la raison d'être du composant. Rendu comme un fil vide,
// une panne de base laissait répondre par-dessus un historique jamais chargé :
// l'agent recevait un message dont le contexte affiché était faux, et personne
// ne pouvait le savoir. Un échec se dit (inv. #4), il ne se dessine pas en
// silence comme une conversation neuve.

import Link from 'next/link';
import EmptyState from '@/components/ui/EmptyState';
import ConversationFeedView from './ConversationFeedView.tsx';
import LiveRefresh from './LiveRefresh.tsx';
import ProjectComposer from './ProjectComposer.tsx';
import type { ConversationThreadView } from '@/lib/conversation-actions.ts';
import type { ComposerPresentation } from '@/lib/project-landing.ts';
import type { ComposerLlmKey } from '@/app/(dashboard)/chat/ModelEffortChip.tsx';
import ThreadScreen from '@/app/(dashboard)/chat/[id]/ThreadScreen.tsx';
import PendingTurn, { PendingTurnProvider } from '@/app/(dashboard)/chat/PendingTurn.tsx';
import { feedSignature } from '@/app/(dashboard)/chat/feed-signature.ts';

export type ProjectThreadResult =
  | { ok: true; data: ConversationThreadView }
  | { ok: false; code: string; message: string };

export default function ProjectThread({
  projectId,
  conversationId,
  thread,
  composer,
  statusBar,
  agentId,
  llmKeyId,
  model,
  reasoningEffort,
  llmKeys,
  requireTools,
}: {
  projectId: string;
  /**
   * La conversation que la saisie PROLONGE : `null` quand le premier envoi
   * doit en créer une (projet neuf, ou fil d'un canal qu'on lit sans pouvoir
   * y répondre depuis le web).
   */
  conversationId: string | null;
  /** `null` quand il n'y avait rien à lire. */
  thread: ProjectThreadResult | null;
  /**
   * Ce que la saisie dit d'elle-même — à qui elle écrit VRAIMENT, ce qu'elle
   * va faire, ou pourquoi elle n'est pas là. Calculé par `composerPresentation`
   * (pur, testé) : le composant ne déduit plus rien du fil affiché, qui peut
   * être celui d'un autre agent (revue Codex, passes 60-61).
   */
  composer: ComposerPresentation;
  /** La barre d'état, ancrée tout en bas de l'écran. */
  statusBar?: React.ReactNode;
  /**
   * #138 — les trois listes « provider / modèle / effort » de la saisie. Rien
   * qu'un passage : l'agent visé et ses réglages sont lus par la page, côté
   * serveur. Sans agent, pas de listes.
   */
  agentId?: string | null;
  llmKeyId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  llmKeys?: ComposerLlmKey[];
  requireTools?: boolean;
}) {
  if (thread !== null && !thread.ok) {
    return (
      <div className="mx-auto mt-8 max-w-[760px]">
        <p className="text-sm text-err">{thread.message}</p>
      </div>
    );
  }

  const items = thread !== null ? thread.data.feed.items : [];
  return (
    // Le message envoyé paraît TOUT DE SUITE dans le fil, avec l'agent qui
    // réfléchit (Quentin, 18/09) — même porteur que /chat/[id].
    <PendingTurnProvider signature={feedSignature(items.length, items.at(-1)?.kind ?? '')}>
      <ThreadScreen composer={composerSlot()} {...(statusBar !== undefined ? { statusBar } : {})}>
        <div>
          {thread !== null ? (
            <>
              {/* P10a — la page d'un projet ne se rafraîchissait pas toute seule,
                  alors que celles de /chat et /scheduled le font depuis P2. Une
                  question posée pendant qu'on la regarde n'y serait jamais
                  apparue : le fil serait resté au dernier rendu, et la carte à
                  boutons avec lui. `live` est déjà calculé par le même chargeur
                  que les deux autres pages — il n'était simplement pas branché. */}
              <LiveRefresh live={thread.data.live} />
              <ConversationFeedView
                feed={thread.data.feed}
                deliverables={thread.data.verification.deliverables}
              />
            </>
          ) : (
            <div className="mx-auto max-w-[760px]">
              <EmptyState title="Nothing said here yet" compact />
            </div>
          )}
          <PendingTurn
            agentName={composer.kind === 'blocked' ? 'Agent' : (composer.agentName ?? 'Agent')}
          />
        </div>
      </ThreadScreen>
    </PendingTurnProvider>
  );

  function composerSlot() {
    if (composer.kind === 'blocked') {
      // Pas de ROOT : rien à créer, donc pas de champ — un mot à la place, et
      // le geste qui débloque, cliquable (le même lien que Settings).
      return (
        <p className="mx-auto max-w-[760px] text-body-13 text-ink-4">
          {composer.message}{' '}
          <Link
            href={composer.action.href}
            className="font-medium text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink-3"
          >
            {composer.action.label}
          </Link>
        </p>
      );
    }
    return (
      <>
        {composer.kind === 'start' && composer.note !== null && (
          <p className="mx-auto mb-2 max-w-[760px] text-body-13 text-ink-3">{composer.note}</p>
        )}
        <ProjectComposer
          projectId={projectId}
          conversationId={conversationId}
          agentName={composer.agentName}
          agentId={agentId ?? null}
          llmKeyId={llmKeyId ?? null}
          model={model ?? null}
          reasoningEffort={reasoningEffort ?? null}
          llmKeys={llmKeys ?? []}
          requireTools={requireTools ?? false}
          {...(composer.kind === 'start' ? { placeholder: composer.placeholder } : {})}
        />
      </>
    );
  }
}

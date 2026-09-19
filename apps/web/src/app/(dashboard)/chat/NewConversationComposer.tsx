'use client';

// NewConversationComposer — la saisie d'un fil qui n'a pas encore commencé
// (#248).
//
// C'est `ThreadComposer`, avec le même contrat que `ProjectComposer` : le
// premier envoi CRÉE la conversation, et c'est elle qui reçoit le message.
// Aucune ligne n'est écrite avant — ni en ouvrant l'écran, ni en cliquant
// « New conversation ». C'est exactement ce que #248 corrige : la boîte de
// réception se remplissait de fils vides ouverts et jamais écrits.
//
// Deux points d'arrivée, un seul composeur : sans projet, la conversation naît
// libre (`createConversationAction`, attribuée au ROOT) ; avec un projet, elle
// naît ANCRÉE à lui (`createProjectConversationAction`), pour que l'agent sache
// de quel dossier on parle dès le premier mot.
//
// ET AUCUNE LIGNE NE SURVIT À UN PREMIER ENVOI RATÉ (revue Reviewer C, passe
// 1). Créer puis envoyer fait deux appels : entre les deux, le runner peut être
// coupé. La conversation qui vient de naître serait alors restée vide, et
// l'orphelin de #248 aurait simplement changé de porte. Le chemin d'échec la
// jette — et seulement si elle est VIDE, la garde étant relue en base
// (`discardEmptyConversationAction`) : passé l'ouverture du flux, le runner a
// déjà écrit le tour de la personne, et jeter perdrait ce qu'elle a écrit.
//
// Ce fichier existe pour une raison de React, la même que `ProjectComposer` :
// un composant serveur ne peut pas passer une fonction à un composant client.
// Les rappels sont donc noués ici, du côté client.

import { useRouter } from 'next/navigation';
import ThreadComposer from './ThreadComposer.tsx';
import type { ComposerLlmKey } from './ModelEffortChip.tsx';
import { createConversationAction, discardEmptyConversationAction } from '@/lib/actions.ts';
import { createProjectConversationAction } from '@/lib/project-actions.ts';

/**
 * L'indication de la planche (`398:3917`), et pas « Reply to X… » : rien n'a
 * encore été dit, il n'y a rien à quoi répondre.
 */
export const NEW_CONVERSATION_PLACEHOLDER = 'What are we doing today?';

export default function NewConversationComposer({
  projectId = null,
  agentName,
  agentId,
  llmKeyId,
  model,
  reasoningEffort,
  llmKeys,
  requireTools,
}: {
  /** Le projet auquel la conversation sera ancrée, quand l'écran en porte un. */
  projectId?: string | null;
  /** Le ROOT, celui qui recevra la conversation. */
  agentName?: string | null;
  agentId?: string | null;
  llmKeyId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  llmKeys?: ComposerLlmKey[];
  requireTools?: boolean;
}) {
  const router = useRouter();
  return (
    <ThreadComposer
      // Vide : il n'y a pas encore de conversation. `onBeforeSend` rend la
      // sienne, et c'est elle qui reçoit le message.
      conversationId=""
      placeholder={NEW_CONVERSATION_PLACEHOLDER}
      agentId={agentId ?? null}
      llmKeyId={llmKeyId ?? null}
      model={model ?? null}
      reasoningEffort={reasoningEffort ?? null}
      llmKeys={llmKeys ?? []}
      requireTools={requireTools ?? false}
      {...(agentName !== undefined ? { agentName } : {})}
      onBeforeSend={async () => {
        const r =
          projectId === null
            ? await createConversationAction()
            : await createProjectConversationAction(projectId);
        // Échec FORT (inv. #4) : le composeur remonte le message tel quel et
        // rend son texte, plutôt que d'envoyer on ne sait où.
        if (!r.ok) throw new Error(r.message);
        return r.data.id;
      }}
      // Le fil existe : l'écran DEVIENT ce fil. `replace` et non `push` —
      // revenir en arrière doit ramener d'où l'on venait, pas sur un écran
      // vide qui rouvrirait une seconde conversation.
      onSent={(id) => router.replace(`/chat/${id}`)}
      // L'envoi a échoué : la conversation ouverte pour lui n'a rien reçu.
      // On la jette, et l'écran reste où il est — le texte est déjà retombé
      // dans la zone, on peut réessayer. Un échec du jet ne se dit pas à
      // l'écran : la personne a déjà le message d'erreur de l'envoi, et un
      // second toast sur du ménage ne lui apprendrait rien de ce qu'elle peut
      // faire. Il est journalisé, là où on le cherchera.
      onSendFailed={(id) => {
        void discardEmptyConversationAction(id).then((r) => {
          if (!r.ok) console.error('[new conversation] discard failed', r.code, r.message);
        });
      }}
    />
  );
}

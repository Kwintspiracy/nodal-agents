'use client';

// ProjectComposer — la saisie en bas de la page d'un projet (P8).
//
// C'est `ThreadComposer` (P7), avec une seule différence : tant que le projet
// n'a pas de conversation, le premier envoi en CRÉE une, ancrée au projet, et
// c'est elle qui reçoit le message. Un composant de plus plutôt qu'un second
// composeur, parce que la saisie ne change pas — seul son point d'arrivée
// change.
//
// Ce fichier existe aussi pour une raison de React : un composant serveur ne
// peut pas passer une fonction à un composant client. Le `onBeforeSend` est
// donc noué ici, du côté client, autour de l'action serveur.

import ThreadComposer from '@/app/(dashboard)/chat/ThreadComposer.tsx';
import { createProjectConversationAction } from '@/lib/project-actions.ts';
import type { ComposerLlmKey } from '@/app/(dashboard)/chat/ModelEffortChip.tsx';

export default function ProjectComposer({
  projectId,
  conversationId,
  agentName,
  placeholder,
  agentId,
  llmKeyId,
  model,
  reasoningEffort,
  llmKeys,
}: {
  projectId: string;
  conversationId: string | null;
  /** À qui la saisie écrit VRAIMENT : l'agent du fil prolongé, ou le ROOT qui recevra la conversation créée. */
  agentName?: string | null;
  /** Le placeholder en toutes lettres quand la saisie va OUVRIR une conversation. */
  placeholder?: string;
  /** #138 — les trois listes de réglage, passées telles quelles. */
  agentId?: string | null;
  llmKeyId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  llmKeys?: ComposerLlmKey[];
}) {
  return (
    <ThreadComposer
      conversationId={conversationId ?? ''}
      agentId={agentId ?? null}
      llmKeyId={llmKeyId ?? null}
      model={model ?? null}
      reasoningEffort={reasoningEffort ?? null}
      llmKeys={llmKeys ?? []}
      {...(agentName !== undefined ? { agentName } : {})}
      {...(placeholder !== undefined ? { placeholder } : {})}
      onBeforeSend={
        conversationId !== null
          ? undefined
          : async () => {
              const r = await createProjectConversationAction(projectId);
              // Échec FORT (inv. #4) : le composeur remonte le message tel
              // quel plutôt que d'envoyer le texte on ne sait où.
              if (!r.ok) throw new Error(r.message);
              // PAS de `router.refresh()` ici : `ThreadComposer` relit la page
              // après l'ENVOI. Une relecture entre la création et le premier
              // message montrait la conversation neuve VIDE à la place du fil
              // qu'on lisait, un instant, avec la note en moins (revue Codex,
              // passe 61).
              return r.data.id;
            }
      }
    />
  );
}

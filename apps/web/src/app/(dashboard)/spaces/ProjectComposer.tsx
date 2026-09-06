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

import { useRouter } from 'next/navigation';
import ThreadComposer from '@/app/(dashboard)/chat/ThreadComposer.tsx';
import { createProjectConversationAction } from '@/lib/project-actions.ts';

export default function ProjectComposer({
  projectId,
  conversationId,
}: {
  projectId: string;
  conversationId: string | null;
}) {
  const router = useRouter();

  return (
    <ThreadComposer
      conversationId={conversationId ?? ''}
      onBeforeSend={
        conversationId !== null
          ? undefined
          : async () => {
              const r = await createProjectConversationAction(projectId);
              // Échec FORT (inv. #4) : le composeur remonte le message tel
              // quel plutôt que d'envoyer le texte on ne sait où.
              if (!r.ok) throw new Error(r.message);
              // La page relit le projet : la conversation neuve devient LA
              // conversation du projet, et le fil apparaît au-dessus.
              router.refresh();
              return r.data.id;
            }
      }
    />
  );
}

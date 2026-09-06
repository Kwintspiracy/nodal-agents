// ProjectThread.test.tsx — le bas de la page d'un projet rendu en HTML.
//
// Le cas qui compte : un fil qu'on n'a PAS pu lire. Il doit dire l'erreur et
// retirer la saisie, sinon on répond par-dessus un historique jamais chargé
// (revue passe 30, constat 1). Les deux autres cas sont là pour prouver que la
// saisie, elle, existe bien quand il n'y a rien à cacher.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ProjectThread from '../ProjectThread.tsx';
import type { ConversationThreadView } from '@/lib/conversation-actions.ts';

// La saisie appelle `useRouter`, qui exige un routeur monté. Un rendu statique
// n'en a pas : on le remplace par un objet inerte, puisque ce qui est en jeu
// ici est la PRÉSENCE de la saisie, jamais la navigation.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

/** Un fil lu, avec un seul tour de l'utilisateur. */
const filLu = {
  ok: true as const,
  data: {
    feed: {
      items: [
        {
          kind: 'request' as const,
          text: 'Range le dossier',
          origin: { channel: 'dashboard', scheduleName: null, chatId: null },
        },
      ],
      totals: { turns: 1, inputTokens: 0, outputTokens: 0, costUsd: null },
    },
    // P12 — le fil passe l'état des documents au rendu des cartes. Aucun ici :
    // ce fixture n'a pas de fichier écrit.
    verification: { sequences: [], skippedSurfaces: [], unconfigured: [], deliverables: [] },
  } as unknown as ConversationThreadView,
};

describe('ProjectThread', () => {
  it('un fil qu’on n’a pas pu lire : l’erreur est DITE, et la saisie disparaît', () => {
    const html = renderToStaticMarkup(
      <ProjectThread
        projectId="p-1"
        conversationId="c-1"
        thread={{ ok: false, code: 'db_error', message: 'Failed to load the conversation' }}
      />,
    );
    expect(html).toContain('Failed to load the conversation');
    // Pas de saisie : on ne répond pas par-dessus un historique inconnu.
    expect(html).not.toContain('Write to your agent');
    expect(html).not.toContain('Send');
    // Et surtout, pas de « vide » là où il y a une panne.
    expect(html).not.toContain('Nothing said here yet');
  });

  it('pas encore de conversation : on le dit, et on peut écrire', () => {
    const html = renderToStaticMarkup(
      <ProjectThread projectId="p-1" conversationId={null} thread={null} />,
    );
    expect(html).toContain('Nothing said here yet');
    expect(html).toContain('Write to your agent');
  });

  it('le fil est là : il est dessiné, et on peut écrire', () => {
    const html = renderToStaticMarkup(
      <ProjectThread projectId="p-1" conversationId="c-1" thread={filLu} />,
    );
    expect(html).toContain('Range le dossier');
    expect(html).toContain('Write to your agent');
    expect(html).not.toContain('Nothing said here yet');
  });
});

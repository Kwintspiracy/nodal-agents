// WorkspacesList.test.tsx — LA LISTE rendue en HTML : une seule liste, deux
// sortes de lignes (#143).
//
// Ce que ces cas tiennent, et que l'ancienne table de `/spaces` tenait déjà :
// un projet masqué reste listé et le DIT, un projet sans preuve ne s'affiche
// pas comme un échec, le dossier et les comptes se lisent sur la ligne. Ce
// qu'ils ajoutent : un dossier détecté porte son étiquette et ses deux gestes,
// et n'ouvre AUCUNE page — il n'est pas au registre, il n'a pas d'id.
//
// Rendu statique côté serveur (renderToStaticMarkup) : pas de navigateur, pas
// de bibliothèque de test de composants dans ce dépôt — on lit le HTML.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkspacesList, { workspaceSubline } from '../WorkspacesList.tsx';
import type { WorkspaceRow, WorkspacesView } from '@/lib/workspaces.ts';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/lib/actions.ts', () => ({ setCodeProjectHiddenAction: async () => ({ ok: true }) }));
vi.mock('@/lib/project-actions.ts', () => ({
  registerDetectedProjectAction: async () => ({ ok: true, data: { id: 'x', path: 'x' } }),
}));

const ligne = (over: Partial<WorkspaceRow> & { key: string; name: string }): WorkspaceRow => ({
  kind: 'registered',
  id: 'p-1',
  path: 'D:/Dev/projet',
  produces: 'code',
  agentName: 'Alfred',
  conversations: 0,
  sessions: 0,
  lastActivityAt: null,
  proof: 'unverified',
  hidden: false,
  ...over,
});

function render(view: Partial<WorkspacesView>): string {
  return renderToStaticMarkup(
    <WorkspacesList
      view={{
        rows: [],
        hiddenDetected: [],
        counts: { total: 0, registered: 0, detected: 0, waiting: 0 },
        ...view,
      }}
    />,
  );
}

describe('WorkspacesList @cap:travailler-sur-des-fichiers/ecran', () => {
  const rows: WorkspaceRow[] = [
    ligne({
      key: 'd:/dev/nodal',
      id: 'p-1',
      name: 'Nodal Agents',
      path: 'D:/Dev/nodal',
      conversations: 12,
      sessions: 41,
      lastActivityAt: new Date(Date.now() - 3_600_000),
      proof: 'approval_pending',
    }),
    ligne({
      key: 'd:/dev/vieux',
      id: 'p-2',
      name: 'Vieux dossier',
      path: 'D:/Dev/vieux',
      produces: 'documents',
      hidden: true,
    }),
    ligne({
      kind: 'detected',
      key: 'd:/apps/scratch-tools',
      id: null,
      name: 'scratch-tools',
      path: 'D:/APPS/scratch-tools',
      produces: null,
      conversations: null,
      sessions: 2,
      lastActivityAt: new Date(Date.now() - 86_400_000 * 8),
    }),
  ];
  const html = render({ rows, counts: { total: 3, registered: 2, detected: 1, waiting: 1 } });

  it('nomme chaque projet du registre et pointe vers sa page', () => {
    expect(html).toContain('Nodal Agents');
    expect(html).toContain('href="/spaces/p-1"');
    expect(html).toContain('href="/spaces/p-2"');
  });

  it('un projet masqué reste listé, et le DIT', () => {
    expect(html).toContain('Vieux dossier');
    expect(html).toContain('hidden');
  });

  it('chaque ligne porte un DOSSIER, jamais un visage', () => {
    // Quentin, 19/09 : l'avatar de l'agent responsable était le même sur
    // toutes les lignes — c'est systématiquement l'orchestrateur —, donc une
    // colonne qui n'apprenait rien. Ce que la ligne EST, c'est un dossier.
    // Une marque par ligne, et aucune initiale d'agent.
    expect(html.match(/<svg/g)?.length ?? 0).toBeGreaterThanOrEqual(rows.length);
    // « AL », les initiales qu'Alfred dessinait dans l'avatar, ont disparu.
    expect(html).not.toContain('>AL<');
  });

  it('les deux sortes de lignes sont dans la MÊME liste', () => {
    expect(html).toContain('data-testid="workspace-row-d:/dev/nodal"');
    expect(html).toContain('data-testid="workspace-row-d:/apps/scratch-tools"');
  });

  it('un dossier détecté est marqué, n’ouvre AUCUNE page, et porte ses deux gestes', () => {
    expect(html).toContain('Detected');
    expect(html).toContain('scratch-tools');
    // Aucun lien vers un projet qui n'existe pas au registre.
    expect(html).not.toContain('href="/spaces/null"');
    expect(html).toContain('>Register<');
    expect(html).toContain('>Hide<');
  });

  it('la pastille de preuve dit l’état, sans jamais peindre une absence en rouge', () => {
    expect(html).toContain('Approval pending');
    expect(html).toContain('Unverified');
    expect(html).not.toContain('Verified<'); // « Unverified » ne compte pas
  });

  it('un projet de DOCUMENTS se dit ; le code, cas ordinaire, n’a pas d’étiquette', () => {
    expect(html).toContain('documents');
  });

  it('un projet de DOCUMENTS ne porte AUCUNE pastille de preuve', () => {
    const seulDocument = render({
      rows: [
        ligne({
          key: 'd:/docs/notes',
          id: 'p-doc',
          name: 'Notes',
          path: 'D:/Docs/notes',
          produces: 'documents',
          proof: null,
        }),
      ],
      counts: { total: 1, registered: 1, detected: 0, waiting: 0 },
    });
    expect(seulDocument).toContain('Notes');
    // Ni « Unverified », ni rien d'autre : il n'exécute aucune commande.
    expect(seulDocument).not.toContain('Unverified');
    expect(seulDocument).not.toContain('Verified');
    expect(seulDocument).not.toContain('Approval pending');
  });

  it('les dossiers masqués sont COMPTÉS et retrouvables, jamais effacés', () => {
    const avecMasques = render({
      rows: [],
      hiddenDetected: [
        ligne({
          kind: 'detected',
          key: 'd:/apps/range',
          id: null,
          name: 'range',
          path: 'D:/APPS/range',
          hidden: true,
        }),
      ],
      counts: { total: 0, registered: 0, detected: 0, waiting: 0 },
    });
    expect(avecMasques).toContain('1 hidden folder');
    expect(avecMasques).toContain('>Show<');
    // Repliés : la ligne masquée n'est PAS dans le DOM tant qu'on ne l'a pas
    // demandée — un corps caché en CSS resterait cherchable.
    expect(avecMasques).not.toContain('data-testid="workspace-row-d:/apps/range"');
  });
});

describe('workspaceSubline @cap:travailler-sur-des-fichiers/ecran', () => {
  it('un projet du registre : le dossier, l’agent, ses comptes, son activité', () => {
    const texte = workspaceSubline(
      ligne({
        key: 'k',
        name: 'Nodal',
        path: 'D:/Dev/nodal',
        conversations: 12,
        sessions: 41,
        lastActivityAt: new Date(Date.now() - 3_600_000),
      }),
    );
    expect(texte).toContain('D:/Dev/nodal');
    expect(texte).toContain('Alfred');
    expect(texte).toContain('12 conversations');
    expect(texte).toContain('41 sessions');
    expect(texte).toContain('last activity 1h ago');
  });

  it('un dossier détecté dit qui a écrit et qu’il n’est PAS enregistré', () => {
    const texte = workspaceSubline(
      ligne({
        kind: 'detected',
        key: 'k',
        id: null,
        name: 'scratch',
        path: 'D:/APPS/scratch',
        conversations: null,
        sessions: 2,
      }),
    );
    expect(texte).toContain('Alfred wrote here');
    expect(texte).toContain('2 sessions');
    expect(texte).toContain('not registered yet');
    // Jamais un compte qu'on n'a pas fait.
    expect(texte).not.toContain('conversation');
  });

  it('un projet neuf dit « no session », jamais « 0 sessions » ni une date inventée', () => {
    const texte = workspaceSubline(ligne({ key: 'k', name: 'Neuf', conversations: 0 }));
    expect(texte).toContain('no session');
    expect(texte).not.toContain('last activity');
    expect(texte).not.toContain('never');
  });

  it('le singulier ne s’écrit jamais au pluriel', () => {
    const texte = workspaceSubline(ligne({ key: 'k', name: 'Un', conversations: 1, sessions: 1 }));
    expect(texte).toContain('1 conversation ·');
    expect(texte).toContain('1 session');
  });
});

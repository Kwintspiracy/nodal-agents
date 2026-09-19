// WorkspacesList.test.tsx — LA LISTE rendue en HTML : une seule liste, deux
// sortes de lignes (#143).
//
// Ce que ces cas tiennent, et que l'ancienne table de `/spaces` tenait déjà :
// un projet masqué reste listé et le DIT, et un projet sans preuve ne s'affiche
// pas comme un échec. Ce qu'ils ajoutent : un dossier détecté porte son
// étiquette et ses deux gestes, et n'ouvre AUCUNE page — il n'est pas au
// registre, il n'a pas d'id.
//
// Et depuis le 19/09, ce que la ligne NE DIT PLUS : le nom de l'agent
// responsable, les comptes de conversations et de sessions, la dernière
// activité. On parle toujours au même orchestrateur, donc son nom était la
// même colonne répétée. Un cas l'assert, parce qu'une colonne retirée revient
// sans qu'on le remarque.
//
// Rendu statique côté serveur (renderToStaticMarkup) : pas de navigateur, pas
// de bibliothèque de test de composants dans ce dépôt — on lit le HTML.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkspacesList from '../WorkspacesList.tsx';
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
  createdAt: null,
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
      createdAt: new Date(Date.now() - 3_600_000),
      proof: 'approval_pending',
    }),
    ligne({
      key: 'd:/dev/vieux',
      id: 'p-2',
      name: 'Vieux dossier',
      path: 'D:/Dev/vieux',
      produces: 'documents',
      proof: null,
      hidden: true,
    }),
    ligne({
      kind: 'detected',
      key: 'd:/apps/scratch-tools',
      id: null,
      name: 'scratch-tools',
      path: 'D:/APPS/scratch-tools',
      produces: null,
      createdAt: new Date(Date.now() - 86_400_000 * 8),
    }),
  ];
  const html = render({ rows, counts: { total: 3, registered: 2, detected: 1, waiting: 1 } });

  it('nomme chaque projet du registre et pointe vers sa page', () => {
    expect(html).toContain('Nodal Agents');
    expect(html).toContain('href="/spaces/p-1"');
    expect(html).toContain('href="/spaces/p-2"');
  });

  it('montre le CHEMIN de chaque ligne, et le garde entier au survol', () => {
    expect(html).toContain('D:/Dev/nodal');
    expect(html).toContain('D:/APPS/scratch-tools');
    expect(html).toContain('title="D:/Dev/nodal"');
  });

  it('ne dit PLUS l’agent, ni les comptes, ni la dernière activité', () => {
    // Le constat de Quentin, 19/09. Une colonne retirée revient sans qu'on le
    // remarque : ce cas est ce qui l'en empêche.
    expect(html).not.toContain('conversation');
    expect(html).not.toContain('session');
    expect(html).not.toContain('last activity');
    expect(html).not.toContain('wrote here');
  });

  it('un projet masqué reste listé, et le DIT', () => {
    expect(html).toContain('Vieux dossier');
    expect(html).toContain('hidden');
  });

  it('chaque ligne porte un DOSSIER, jamais un visage', () => {
    // Une marque par ligne, et aucune initiale d'agent.
    expect(html.match(/<svg/g)?.length ?? 0).toBeGreaterThanOrEqual(rows.length);
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

  it('une ligne SANS date ne porte pas de tiret à sa place', () => {
    const sansDate = render({
      rows: [ligne({ key: 'k', name: 'Neuf', createdAt: null })],
      counts: { total: 1, registered: 1, detected: 0, waiting: 0 },
    });
    expect(sansDate).toContain('Neuf');
    expect(sansDate).not.toContain('>—<');
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

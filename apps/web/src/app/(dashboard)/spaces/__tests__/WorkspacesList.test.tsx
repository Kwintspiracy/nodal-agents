// WorkspacesList.test.tsx — LA LISTE rendue en HTML : une seule liste, deux
// sortes de lignes (#143).
//
// Ce que ces cas tiennent : un projet sans preuve ne s'affiche pas comme un
// échec, et ce qu'on a RETIRÉ de la liste n'y est plus — il est derrière
// « Hidden (N) », avec le geste qui l'y remet (#364). Ce qu'ils ajoutent : un dossier détecté porte son
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

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WorkspacesList from '../WorkspacesList.tsx';
import type { WorkspaceRow, WorkspacesView } from '@/lib/workspaces.ts';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/lib/actions.ts', () => ({ setCodeProjectHiddenAction: vi.fn() }));
vi.mock('@/lib/project-actions.ts', () => ({
  registerDetectedProjectAction: async () => ({ ok: true, data: { id: 'x', path: 'x' } }),
}));

import { setCodeProjectHiddenAction } from '@/lib/actions.ts';

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
        hiddenRows: [],
        counts: { total: 0, registered: 0, detected: 0, waiting: 0 },
        ...view,
      }}
    />,
  );
}

/** Un projet du REGISTRE que le propriétaire a retiré de la liste. */
const masque = ligne({
  key: 'd:/dev/range',
  id: 'p-range',
  name: 'Rangé',
  path: 'D:/Dev/range',
  hidden: true,
});

/** Un dossier DÉTECTÉ retiré, lui aussi : la même section les porte tous deux. */
const masqueDetecte = ligne({
  kind: 'detected',
  key: 'd:/apps/range',
  id: null,
  name: 'range',
  path: 'D:/APPS/range',
  produces: null,
  hidden: true,
});

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

  it('montre le CHEMIN de chaque ligne, ENTIER, et le garde entier au survol', () => {
    expect(html).toContain('D:/Dev/nodal');
    expect(html).toContain('D:/APPS/scratch-tools');
    expect(html).toContain('title="D:/Dev/nodal"');
  });

  it('un chemin LONG est rendu en entier : c’est le CSS qui coupe, pas un compteur', () => {
    // Revue Reviewer C, passe 4. Le chemin passait par un compteur de 44
    // signes qui décidait d'une coupe sans connaître la largeur : sur un écran
    // large il raccourcissait pour rien, sur un étroit le CSS recoupait par
    // dessus. Le texte RENDU est donc le chemin complet, et `truncate` s'en
    // charge à l'affichage.
    const long =
      'D:/APPS/NodalAI/apps/web/src/app/(dashboard)/spaces/un-dossier-au-nom-interminable';
    const rendu = render({
      rows: [ligne({ key: 'k', name: 'Long', path: long })],
      counts: { total: 1, registered: 1, detected: 0, waiting: 0 },
    });
    expect(rendu).toContain(`>${long}</span>`);
    expect(rendu).toContain(`title="${long}"`);
    // Aucune ellipse posée par du code : celle du CSS n'est pas dans le HTML.
    expect(rendu).not.toContain('…');
    expect(rendu).toContain('truncate');
  });

  it('ne dit PLUS l’agent, ni les comptes, ni la dernière activité', () => {
    // Le constat de Quentin, 19/09. Une colonne retirée revient sans qu'on le
    // remarque : ce cas est ce qui l'en empêche.
    expect(html).not.toContain('conversation');
    expect(html).not.toContain('session');
    expect(html).not.toContain('last activity');
    expect(html).not.toContain('wrote here');
  });

  it('sans rien de masqué, AUCUN contrôle « Hidden » ne paraît', () => {
    // « Hidden (0) » poserait une question à laquelle la page a répondu.
    expect(html).not.toContain('Hidden (');
    expect(html).not.toContain('data-testid="hidden-projects-toggle"');
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

  it('les masqués sont COMPTÉS et retrouvables, jamais effacés', () => {
    const avecMasques = render({
      rows: [],
      hiddenRows: [masque, masqueDetecte],
      counts: { total: 0, registered: 0, detected: 0, waiting: 0 },
    });
    expect(avecMasques).toContain('Hidden (2)');
    // Repliés : les lignes masquées ne sont PAS dans le DOM tant qu'on ne les
    // a pas demandées — un corps caché en CSS resterait cherchable.
    expect(avecMasques).not.toContain('data-testid="workspace-row-d:/dev/range"');
    expect(avecMasques).not.toContain('data-testid="workspace-row-d:/apps/range"');
    expect(avecMasques).not.toContain('Show in list');
  });

  it('un projet RETIRÉ n’est pas dans la liste, et il est sous « Hidden »', () => {
    // #364, le constat : « Remove from list » retirait le projet de la barre,
    // renvoyait sur cette page, et la page le montrait toujours.
    const avecMasques = render({
      rows: [ligne({ key: 'd:/dev/garde', id: 'p-9', name: 'Gardé', path: 'D:/Dev/garde' })],
      hiddenRows: [masque],
      counts: { total: 1, registered: 1, detected: 0, waiting: 0 },
    });
    expect(avecMasques).toContain('data-testid="workspace-row-d:/dev/garde"');
    expect(avecMasques).not.toContain('data-testid="workspace-row-d:/dev/range"');
    expect(avecMasques).toContain('Hidden (1)');
  });

  it('le contrôle « Hidden » est un dépliant annoncé, pas un lien', () => {
    const avecMasques = render({
      rows: [],
      hiddenRows: [masque],
      counts: { total: 0, registered: 0, detected: 0, waiting: 0 },
    });
    expect(avecMasques).toContain('data-testid="hidden-projects-toggle"');
    expect(avecMasques).toContain('aria-expanded="false"');
    expect(avecMasques).toContain('aria-controls=');
  });
});

// ─── La section « Hidden », DÉPLIÉE ──────────────────────────────────────────
//
// Le repli se prouve sur le HTML (plus haut) ; l'OUVERTURE demande un clic,
// donc un vrai DOM. On lit ce qui s'affiche et ce que « Show in list » envoie
// à l'action — son ARGUMENT, jamais un compteur d'appels.

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function monter(view: Partial<WorkspacesView>): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <WorkspacesList
        view={{
          rows: [],
          hiddenRows: [],
          counts: { total: 0, registered: 0, detected: 0, waiting: 0 },
          ...view,
        }}
      />,
    );
  });
}

function rendu(): HTMLDivElement {
  if (!container) throw new Error('rien monté');
  return container;
}

async function cliquer(texte: string): Promise<void> {
  const el = [...rendu().querySelectorAll('button')].find((b) => b.textContent?.trim() === texte);
  if (!el) throw new Error(`bouton introuvable : ${texte}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setCodeProjectHiddenAction).mockResolvedValue({ ok: true, data: undefined });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('la section Hidden de la page Projects @cap:travailler-sur-des-fichiers/ecran', () => {
  it('« Hidden (2) » déplie les deux projets retirés, et dit que rien n’est effacé', async () => {
    await monter({
      rows: [ligne({ key: 'd:/dev/garde', id: 'p-9', name: 'Gardé', path: 'D:/Dev/garde' })],
      hiddenRows: [masque, masqueDetecte],
      counts: { total: 1, registered: 1, detected: 0, waiting: 0 },
    });
    // Avant le clic : les retirés ne sont NULLE PART dans la page.
    expect(rendu().querySelector('[data-testid="workspace-row-d:/dev/range"]')).toBeNull();
    expect(rendu().querySelector('[data-testid="workspace-row-d:/apps/range"]')).toBeNull();

    await cliquer('Hidden (2)');

    expect(rendu().querySelector('[data-testid="workspace-row-d:/dev/range"]')).not.toBeNull();
    expect(rendu().querySelector('[data-testid="workspace-row-d:/apps/range"]')).not.toBeNull();
    // La ligne qui reste, elle, n'a pas bougé de la liste principale.
    expect(rendu().querySelector('[data-testid="workspace-row-d:/dev/garde"]')).not.toBeNull();
    expect(rendu().textContent).toContain('Nothing is deleted');
    expect(
      rendu()
        .querySelector('[data-testid="hidden-projects-toggle"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('« Show in list » remet le projet dans la liste : `hidden: false`, sur SON chemin', async () => {
    await monter({
      rows: [],
      hiddenRows: [masque],
      counts: { total: 0, registered: 0, detected: 0, waiting: 0 },
    });
    await cliquer('Hidden (1)');
    await cliquer('Show in list');

    // L'ARGUMENT de l'action, pas le nombre d'appels : c'est lui qui décide.
    expect(vi.mocked(setCodeProjectHiddenAction).mock.calls.at(0)?.[0]).toEqual({
      projectPath: 'D:/Dev/range',
      hidden: false,
    });
  });

  it('un dossier DÉTECTÉ retiré porte le MÊME geste, sur son chemin à lui', async () => {
    await monter({
      rows: [],
      hiddenRows: [masqueDetecte],
      counts: { total: 0, registered: 0, detected: 0, waiting: 0 },
    });
    await cliquer('Hidden (1)');
    await cliquer('Show in list');

    expect(vi.mocked(setCodeProjectHiddenAction).mock.calls.at(0)?.[0]).toEqual({
      projectPath: 'D:/APPS/range',
      hidden: false,
    });
  });
});

// RunsFolderList.test.tsx — le dossier MCP, RENDU et CLIQUÉ (#179, puis #183).
//
// Ce qu'il prouve, et qu'aucun test pur ne voit :
//
//   - la liste affiche ses runs, chacun avec son titre et un lien vers SA page,
//     et elle ne porte ni saisie ni bouton de création ;
//   - « Load more » demande la page suivante AVEC le curseur rendu par la
//     précédente, et l'ajoute sous les lignes déjà là — sans doublon ;
//   - le mode sélection coche, coche tout, et ne supprime qu'APRÈS confirmation
//     par `<ConfirmDialog />`, jamais par un dialogue natif (invariant #10) ;
//   - un run VIVANT a sa case désactivée, « Select all » ne le prend pas, et
//     l'écran dit pourquoi.
//
// Rendu dans jsdom et CLIQUÉ : les assertions portent sur le contenu rendu et
// sur ce que l'action mockée a REÇU, jamais sur des appels comptés (invariant
// #5).
//
// Mutations vérifiées : le curseur non transmis à `listExternalRunsAction` →
// « demande la suite avec le curseur » rougit ; `disabled` retiré de la case →
// « ne coche que les runs terminés » rougit ; le dédoublonnage retiré →
// « ne double aucune ligne » rougit ; l'état vide remplacé par une boîte vide →
// « dit qu'il n'y a rien » rougit.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ExternalRunRow, ExternalRunsPage } from '@/lib/conversation-actions.ts';

type ListResult =
  | { ok: true; data: ExternalRunsPage }
  | { ok: false; code: string; message: string };
type DeleteResult =
  | { ok: true; data: { deletedIds: string[]; skippedLiveIds: string[] } }
  | { ok: false; code: string; message: string };

const listExternalRunsAction = vi.hoisted(() =>
  vi.fn(
    async (_opts?: { cursor?: string | null }): Promise<ListResult> => ({
      ok: true as const,
      data: { runs: [], nextCursor: null },
    }),
  ),
);
const deleteExternalRunsAction = vi.hoisted(() =>
  vi.fn(
    async (ids: readonly string[]): Promise<DeleteResult> => ({
      ok: true as const,
      data: { deletedIds: [...ids], skippedLiveIds: [] },
    }),
  ),
);
const refresh = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/conversation-actions.ts', () => ({
  listExternalRunsAction,
  deleteExternalRunsAction,
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

import RunsFolderList from '../RunsFolderList.tsx';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

function run(over: Partial<ExternalRunRow> = {}): ExternalRunRow {
  return {
    id: 'r-1',
    task: 'Résumer les tickets ouverts',
    status: 'completed',
    createdAt: new Date('2026-09-18T09:00:00'),
    ...over,
  };
}

/** Deux runs : le premier TOURNE, le second est terminé. */
const DEUX_RUNS: ExternalRunRow[] = [
  run({ id: 'r-1', task: 'Résumer les tickets ouverts', status: 'processing' }),
  run({ id: 'r-2', task: 'Publier la note de version', status: 'completed' }),
];

async function render(
  runs: ExternalRunRow[],
  cursor: string | null = null,
  waiting: { rootJobId: string | null; kind: string }[] = [],
): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<RunsFolderList initialRuns={runs} initialCursor={cursor} waiting={waiting} />);
  });
}

/** Un bouton par son libellé, DANS TOUT LE DOCUMENT — la confirmation est un portail. */
function bouton(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === label,
  );
  if (!found) throw new Error(`aucun bouton « ${label} » — boutons présents : ${libelles()}`);
  return found as HTMLButtonElement;
}

function libelles(): string {
  return [...document.querySelectorAll('button')]
    .map((b) => `« ${(b.textContent ?? '').trim()} »`)
    .join(', ');
}

async function clic(label: string): Promise<void> {
  const el = bouton(label);
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Le DERNIER bouton portant ce libellé : celui du portail de confirmation. */
async function confirmer(label: string): Promise<void> {
  const tous = [...document.querySelectorAll('button')].filter(
    (b) => (b.textContent ?? '').trim() === label,
  );
  await act(async () => {
    tous[tous.length - 1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function cases(): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
}

function liens(): (string | null)[] {
  return [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
}

describe('le dossier MCP liste les runs venus de dehors @cap:parler-par-canal-externe/ecran', () => {
  it('affiche chaque run avec son titre, et mène à la page du run', async () => {
    await render(DEUX_RUNS);
    expect(liens()).toEqual(['/jobs/r-1', '/jobs/r-2']);
    expect(container.textContent).toContain('Résumer les tickets ouverts');
    expect(container.textContent).toContain('Publier la note de version');
  });

  it('dit sur la ligne ce qui attend la personne, et ce qui tourne', async () => {
    await render(DEUX_RUNS, null, [{ rootJobId: 'r-2', kind: 'question' }]);
    expect(container.textContent).toContain('Question asked');
    const lignes = [...container.querySelectorAll('a')];
    expect(lignes[0]?.querySelector('.bg-ok')).not.toBeNull();
    expect(lignes[1]?.querySelector('.bg-ok')).toBeNull();
  });

  it('n’offre NI composition NI création — ce ne sont pas des conversations', async () => {
    await render(DEUX_RUNS);
    expect(container.querySelector('input[type="text"]')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(document.body.textContent).not.toContain('New conversation');
  });

  it('dit qu’il n’y a rien plutôt que de montrer une boîte vide', async () => {
    await render([]);
    expect(container.textContent).toContain('No run started from outside Nodal yet.');
    expect(container.querySelector('a')).toBeNull();
  });
});

describe('la liste se charge page par page @cap:parler-par-canal-externe/ecran', () => {
  it('ne propose « Load more » que s’il reste quelque chose', async () => {
    await render(DEUX_RUNS, null);
    expect(document.body.textContent).not.toContain('Load more');
    await render(DEUX_RUNS, '2026-09-18T09:00:00.000Z|r-2');
    expect(document.body.textContent).toContain('Load more');
  });

  it('demande la suite AVEC le curseur, et l’ajoute sous les lignes déjà là', async () => {
    listExternalRunsAction.mockResolvedValueOnce({
      ok: true,
      data: { runs: [run({ id: 'r-3', task: 'Trier la boîte' })], nextCursor: null },
    });
    await render(DEUX_RUNS, '2026-09-18T09:00:00.000Z|r-2');
    await clic('Load more');
    // Le CURSEUR reçu, pas un rang : c'est toute la différence avec un `offset`.
    expect(listExternalRunsAction).toHaveBeenCalledWith({
      cursor: '2026-09-18T09:00:00.000Z|r-2',
    });
    expect(liens()).toEqual(['/jobs/r-1', '/jobs/r-2', '/jobs/r-3']);
    expect(container.textContent).toContain('Trier la boîte');
    // Plus rien après : le bouton disparaît plutôt que de promettre une page vide.
    expect(document.body.textContent).not.toContain('Load more');
  });

  it('ne double AUCUNE ligne quand la page suivante en renvoie une déjà là', async () => {
    listExternalRunsAction.mockResolvedValueOnce({
      ok: true,
      data: { runs: [run({ id: 'r-2' }), run({ id: 'r-4', task: 'La suite' })], nextCursor: null },
    });
    await render(DEUX_RUNS, 'curseur');
    await clic('Load more');
    expect(liens()).toEqual(['/jobs/r-1', '/jobs/r-2', '/jobs/r-4']);
  });

  it('DIT qu’une page n’a pas pu être lue, plutôt que de s’arrêter en silence', async () => {
    listExternalRunsAction.mockResolvedValueOnce({
      ok: false,
      code: 'db_error',
      message: 'Failed to load the runs started from outside',
    });
    await render(DEUX_RUNS, 'curseur');
    await clic('Load more');
    expect(container.textContent).toContain('The next runs couldn’t be read just now.');
    // Le bouton reste : la suite existe toujours, on n'a pas pu la lire.
    expect(document.body.textContent).toContain('Load more');
  });
});

describe('sélectionner et supprimer des runs @cap:parler-par-canal-externe/ecran', () => {
  it('n’affiche aucune case tant qu’on n’est pas en sélection', async () => {
    await render(DEUX_RUNS);
    expect(cases()).toHaveLength(0);
    expect(document.body.textContent).toContain('Select');
  });

  it('« Delete » DEMANDE, et ne supprime qu’après confirmation', async () => {
    await render(DEUX_RUNS);
    await clic('Select');
    await act(async () => {
      cases()[1]!.click();
    });
    await clic('Delete');
    // La demande est posée par le dialogue du design system, et RIEN n'est
    // encore parti.
    expect(document.body.textContent).toContain('Delete this run?');
    expect(deleteExternalRunsAction).not.toHaveBeenCalled();

    await confirmer('Delete');
    expect(deleteExternalRunsAction).toHaveBeenCalledWith(['r-2']);
    // La ligne quitte l'écran sans attendre un rechargement, et la barre
    // latérale est prévenue — elle compte ces runs elle aussi.
    expect(liens()).toEqual(['/jobs/r-1']);
    expect(toastSuccess).toHaveBeenCalledWith('1 run deleted');
    expect(refresh).toHaveBeenCalled();
  });

  it('ne coche QUE les runs terminés, « Select all » compris', async () => {
    await render([...DEUX_RUNS, run({ id: 'r-5', task: 'Encore une', status: 'failed' })]);
    await clic('Select');
    // `r-1` tourne : sa case est désactivée.
    expect(cases().map((c) => c.disabled)).toEqual([true, false, false]);
    await clic('Select all');
    expect(container.textContent).toContain('2 selected');
    await clic('Delete');
    await confirmer('Delete');
    expect(deleteExternalRunsAction).toHaveBeenCalledWith(['r-2', 'r-5']);
  });

  it('dit POURQUOI un run ne peut pas être coché', async () => {
    await render(DEUX_RUNS);
    await clic('Select');
    expect(container.textContent).toContain('1 run is still going, so it can’t be deleted yet.');
    expect(cases()[0]?.getAttribute('aria-label')).toContain('is still going');
  });

  it('« Cancel » sort du mode et décoche tout', async () => {
    await render(DEUX_RUNS);
    await clic('Select');
    await act(async () => {
      cases()[1]!.click();
    });
    await clic('Cancel');
    expect(cases()).toHaveLength(0);
    expect(deleteExternalRunsAction).not.toHaveBeenCalled();
  });

  it('DIT ce que l’action a vraiment supprimé, pas ce qu’on avait coché', async () => {
    deleteExternalRunsAction.mockResolvedValueOnce({
      ok: true,
      data: { deletedIds: [], skippedLiveIds: ['r-2'] },
    });
    await render(DEUX_RUNS);
    await clic('Select');
    await act(async () => {
      cases()[1]!.click();
    });
    await clic('Delete');
    await confirmer('Delete');
    expect(toastSuccess).toHaveBeenCalledWith('0 runs deleted');
    expect(toastError).toHaveBeenCalledWith('1 run was left: it started again before the delete.');
  });

  it('GARDE la ligne que l’action a refusée, et retire les autres', async () => {
    // Le défaut de la passe 1 (Reviewer C) : l'écran retirait TOUTES les lignes
    // cochées, y compris celle que le serveur refuse parce qu'elle est repartie,
    // pendant que le message disait qu'elle restait. `router.refresh()` ne la
    // ramenait pas : cette liste garde son état jusqu'à un rechargement complet.
    deleteExternalRunsAction.mockResolvedValueOnce({
      ok: true,
      // `r-3` est parti, `r-2` a redémarré entre le clic et l'écriture.
      data: { deletedIds: ['r-3'], skippedLiveIds: ['r-2'] },
    });
    await render([...DEUX_RUNS, run({ id: 'r-3', task: 'Trier la boîte' })]);
    await clic('Select');
    await act(async () => {
      cases()[1]!.click();
      cases()[2]!.click();
    });
    await clic('Delete');
    await confirmer('Delete');

    // La ligne refusée est TOUJOURS LÀ, celle qui est partie ne l'est plus.
    expect(liens()).toEqual(['/jobs/r-1', '/jobs/r-2']);
    expect(container.textContent).toContain('Publier la note de version');
    expect(container.textContent).not.toContain('Trier la boîte');
    // Et les deux messages disent la même chose que l'écran.
    expect(toastSuccess).toHaveBeenCalledWith('1 run deleted');
    expect(toastError).toHaveBeenCalledWith('1 run was left: it started again before the delete.');
  });

  it('DIT quand la chaîne est trop profonde, et ne retire aucune ligne', async () => {
    // L'action refuse plutôt que de laisser des délégués orphelins : rien ne
    // doit disparaître de l'écran non plus.
    deleteExternalRunsAction.mockResolvedValueOnce({
      ok: false,
      code: 'chain_too_deep',
      message: 'These runs delegate deeper than this screen can follow. Nothing was deleted.',
    });
    await render(DEUX_RUNS);
    await clic('Select');
    await act(async () => {
      cases()[1]!.click();
    });
    await clic('Delete');
    await confirmer('Delete');
    expect(toastError).toHaveBeenCalledWith(
      'These runs delegate deeper than this screen can follow. Nothing was deleted.',
    );
    expect(liens()).toEqual(['/jobs/r-1', '/jobs/r-2']);
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

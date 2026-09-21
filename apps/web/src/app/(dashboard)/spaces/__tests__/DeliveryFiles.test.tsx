// DeliveryFiles.test.tsx — L'ENCART DE LIVRAISON MONTRE CE QUI A CHANGÉ (#369).
//
// Ce que ce fichier prouve, dans le DOM rendu : sous « Files », chaque fichier
// porte sa plaque, REPLIÉE, avec le chemin et « +N −M » ; le clic la déplie et
// fait paraître les lignes du diff ; rien n'est demandé avant ce clic, et un
// second fichier ne redemande rien ; un travail sans fichier ne dessine aucune
// plaque du tout.
//
// Le constat de départ (Quentin, 21/09) : l'encart listait des chemins, et la
// personne s'attendait à lire ce qui avait changé dedans.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Le bouton Stop de l'encart lit le routeur de Next ; hors de l'app, il n'y a
// pas de routeur monté.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

const getRunFileChangesAction = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true as const,
    data: [
      {
        filePath: 'src/a.ts',
        addedLines: 3,
        removedLines: 1,
        edits: [{ filePath: 'src/a.ts', kind: 'edit' as const, oldText: 'beta', newText: 'BETA' }],
      },
      {
        filePath: 'src/b.ts',
        addedLines: 1,
        removedLines: 0,
        edits: [{ filePath: 'src/b.ts', kind: 'write' as const, oldText: null, newText: 'seul' }],
      },
    ],
  })),
);

vi.mock('@/lib/run-file-changes-actions.ts', () => ({ getRunFileChangesAction }));

import DeliveryBlock from '../DeliveryBlock.tsx';
import type { DeliverySummary } from '@/lib/conversation-feed.ts';

const EMPTY: DeliverySummary = {
  files: 0,
  fileChanges: [],
  lines: null,
  tests: null,
  durationMs: null,
  costUsd: null,
  reviews: [],
  checks: [],
  verdict: null,
  review: null,
  changesRequested: false,
  commands: [],
  produced: true,
  ended: null,
  live: null,
};

const DEUX: DeliverySummary = {
  ...EMPTY,
  files: 2,
  fileChanges: [
    { path: 'src/a.ts', addedLines: 3, removedLines: 1, changeKind: 'modified' as const },
    { path: 'src/b.ts', addedLines: 1, removedLines: 0, changeKind: 'added' as const },
  ],
};

let container: HTMLDivElement;
let root: Root;

async function render(node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Les lignes de diff peintes à l'écran, signe et texte. */
function lignes(): Array<[string, string]> {
  return [...container.querySelectorAll('[data-diff]')].map((el) => [
    el.getAttribute('data-diff') ?? '',
    el.textContent ?? '',
  ]);
}

beforeEach(() => {
  getRunFileChangesAction.mockClear();
});

describe('DeliveryBlock — le diff de chaque fichier @cap:travailler-sur-des-fichiers/ecran', () => {
  it('une plaque par fichier, REPLIÉE, avec le chemin et « +N −M »', async () => {
    await render(<DeliveryBlock summary={DEUX} jobId="job-7" filesJobId="job-7" />);

    const plaques = container.querySelectorAll('[data-testid="file-change-kind"]');
    expect(plaques).toHaveLength(2);
    // Le geste, le chemin, et ce que le fichier a pris de lignes. Le mot est
    // JUSTE avant le premier clic : il vient de l'en-tête, pas des fragments
    // qui ne sont pas encore chargés.
    expect(plaques[0]?.textContent).toBe('modified');
    expect(plaques[1]?.textContent).toBe('added');
    const entete = plaques[0]?.closest('button')?.textContent ?? '';
    expect(entete).toContain('src/a.ts');
    expect(entete).toContain('+3');
    expect(entete).toContain('−1');
    // Repliée : le bouton le DIT, aucune ligne de diff, et rien n'a été demandé.
    expect(plaques[0]?.closest('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(lignes()).toEqual([]);
    expect(getRunFileChangesAction).not.toHaveBeenCalled();
  });

  it('le clic déplie la plaque et montre les lignes du diff', async () => {
    await render(<DeliveryBlock summary={DEUX} jobId="job-7" filesJobId="job-7" />);
    const bouton = container.querySelector('[data-testid="file-change-kind"]')?.closest('button');
    expect(bouton).not.toBeNull();
    await click(bouton!);

    expect(getRunFileChangesAction).toHaveBeenCalledTimes(1);
    expect(getRunFileChangesAction).toHaveBeenCalledWith({ jobId: 'job-7' });
    // Les VRAIES lignes du fragment, pas un panneau vide : la ligne remplacée
    // et celle qui l'a remplacée.
    const peintes = lignes();
    expect(peintes).toContainEqual(['-', expect.stringContaining('beta')]);
    expect(peintes).toContainEqual(['+', expect.stringContaining('BETA')]);
  });

  it('le second fichier ne redemande rien : un appel par travail', async () => {
    await render(<DeliveryBlock summary={DEUX} jobId="job-7" filesJobId="job-7" />);
    const boutons = [...container.querySelectorAll('[data-testid="file-change-kind"]')].map((el) =>
      el.closest('button'),
    );
    await click(boutons[0]!);
    await click(boutons[1]!);

    expect(getRunFileChangesAction).toHaveBeenCalledTimes(1);
    // Et le second fichier montre bien SON contenu, pas celui du premier.
    expect(lignes()).toContainEqual(['+', expect.stringContaining('seul')]);
  });

  it('deux fichiers au MÊME chemin affiché gardent chacun SON diff', async () => {
    // Reviewer C, #380. Leur identité est le chemin brut, qui ne sort jamais du
    // serveur (#161) : deux fichiers qui ne diffèrent que par un jeton masquent
    // vers le même texte. Une correspondance par chemin en perdait un, et les
    // deux plaques montraient le même diff.
    const masque = 'cles/[secret] (sk-).txt';
    getRunFileChangesAction.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          filePath: masque,
          addedLines: 1,
          removedLines: 0,
          edits: [{ filePath: masque, kind: 'write', oldText: null, newText: 'PREMIER' }],
        },
        {
          filePath: masque,
          addedLines: 1,
          removedLines: 0,
          edits: [{ filePath: masque, kind: 'write', oldText: null, newText: 'SECOND' }],
        },
      ],
    } as never);
    await render(
      <DeliveryBlock
        summary={{
          ...EMPTY,
          files: 2,
          fileChanges: [
            { path: masque, addedLines: 1, removedLines: 0, changeKind: 'added' as const },
            { path: masque, addedLines: 1, removedLines: 0, changeKind: 'added' as const },
          ],
        }}
        jobId="job-7"
        filesJobId="job-7"
      />,
    );
    const boutons = [...container.querySelectorAll('[data-testid="file-change-kind"]')].map((el) =>
      el.closest('button'),
    );
    await click(boutons[0]!);
    await click(boutons[1]!);

    const peintes = lignes();
    expect(peintes).toContainEqual(['+', expect.stringContaining('PREMIER')]);
    expect(peintes).toContainEqual(['+', expect.stringContaining('SECOND')]);
  });

  it('un travail sans changement de fichier ne dessine aucune plaque', async () => {
    await render(<DeliveryBlock summary={EMPTY} jobId="job-7" filesJobId="job-7" />);
    expect(container.querySelectorAll('[data-testid="file-change-kind"]')).toHaveLength(0);
    expect(container.querySelector('[data-testid="delivery-files"]')).toBeNull();
    expect(getRunFileChangesAction).not.toHaveBeenCalled();
  });

  it('un chargement qui échoue le DIT, il n’affirme pas une absence', async () => {
    getRunFileChangesAction.mockResolvedValueOnce({
      ok: false,
      code: 'not_found',
      message: 'Job not found',
    } as never);
    await render(<DeliveryBlock summary={DEUX} jobId="job-7" filesJobId="job-7" />);
    await click(container.querySelector('[data-testid="file-change-kind"]')!.closest('button')!);

    expect(container.textContent).toContain('No diff: not_found');
    expect(container.textContent).not.toContain('No text recorded for this change.');
  });
});

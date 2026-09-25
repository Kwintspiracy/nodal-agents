// DeliveryFiles.test.tsx — L'ENCART DE LIVRAISON MONTRE CE QUI A CHANGÉ (#369).
//
// Ce que ce fichier prouve, dans le DOM rendu : sous les cellules, chaque
// fichier porte sa plaque, BORD À BORD et repliée, avec le chemin et
// « +N −M » ; le clic la déplie et
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
  repairs: 0,
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

  it('les plaques vont de BORD À BORD, directement sous les cellules', async () => {
    // Quentin, 22/09 : « the diff/file block shall be edge to edge » (planche
    // « DeliveryBlock », 560:7076). La liste vivait dans une section rembourrée
    // de 16 px, et chaque plaque était une carte arrondie flottant dedans.
    await render(<DeliveryBlock summary={DEUX} jobId="job-7" filesJobId="job-7" />);
    const liste = container.querySelector('[data-testid="delivery-files"]');
    expect(liste).not.toBeNull();

    // AUCUN CONTENEUR INTERMÉDIAIRE : la liste est fille de l'encart lui-même,
    // celui qui porte le cadre arrondi. Donc aucun rembourrage latéral entre
    // la bordure de l'encart et les plaques.
    expect(liste?.parentElement?.className).toContain('rounded-xl');
    expect(liste?.className ?? '').not.toContain('px-');
    // Ni écart entre les plaques : elles se touchent, filet contre filet
    // (Reviewer C, passe 1 : sans ça, remettre un `gap-1.5` laissait le cas
    // vert alors que les plaques flottaient de nouveau).
    expect(liste?.className ?? '').not.toContain('gap-');

    // ET AUCUN TITRE « Files » au-dessus : ce qui précède immédiatement les
    // plaques est la rangée de cellules (Files / Lines / …), pas un libellé.
    const precedent = liste?.previousElementSibling;
    // La rangée de cellules, reconnaissable au libellé COLLÉ à sa valeur, et
    // non un titre seul (Reviewer C, passe 1 : un `2` tout court se serait
    // aussi lu dans « 12 / 12 » ou dans un coût).
    expect(precedent?.textContent).toContain('Files2');
    expect(precedent?.querySelectorAll('[data-testid="file-change-kind"]')).toHaveLength(0);

    // Le dessin : la première plaque porte le filet haut, chacune le filet bas.
    const plaques = [...(liste?.children ?? [])];
    expect(plaques).toHaveLength(2);
    for (const p of plaques) {
      expect(p.className).toContain('w-full');
      expect(p.className).toContain('border-b');
      expect(p.className).toContain('first:border-t');
      // Plus de carte à soi : ni coin arrondi, ni cadre sur les quatre côtés.
      expect(p.className).not.toContain('rounded-xl');
      // Et aucune marge latérale sur la plaque elle-même : « bord à bord »
      // tombe aussi si le rembourrage passe de la section à la plaque
      // (Reviewer C, passe 1).
      expect(p.className).not.toContain('px-');
    }
    // Le mot du geste est GRAS (mesuré : `font-bold` l'emporte bien sur le
    // poids 400 que `text-mono-12` embarque — la feuille compilée pose
    // `.font-bold` APRÈS `.text-mono-12`).
    for (const mot of container.querySelectorAll('[data-testid="file-change-kind"]')) {
      expect(mot.className).toContain('font-bold');
    }
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

describe('DeliveryBlock — un média livré se montre, se joue, se télécharge (#490) @cap:travailler-sur-des-fichiers/ecran', () => {
  const MEDIAS: DeliverySummary = {
    ...EMPTY,
    files: 4,
    fileChanges: [
      {
        path: 'outputs/voix off.wav',
        addedLines: 0,
        removedLines: 0,
        changeKind: 'written' as const,
      },
      { path: 'outputs/cover.png', addedLines: 0, removedLines: 0, changeKind: 'added' as const },
      { path: 'outputs/clip.mp4', addedLines: 0, removedLines: 0, changeKind: 'added' as const },
      { path: 'src/a.ts', addedLines: 3, removedLines: 1, changeKind: 'modified' as const },
    ],
  };

  it('la piste, l’image et la vidéo à la place du diff, servies par la route du run', async () => {
    await render(<DeliveryBlock summary={MEDIAS} jobId="job-7" filesJobId="job-7" />);

    const blocs = [...container.querySelectorAll('[data-testid="delivery-media"]')];
    expect(blocs.map((b) => b.getAttribute('data-media-kind'))).toEqual([
      'audio',
      'image',
      'video',
    ]);

    // Le lecteur lit LE fichier de ce run : chemin affiché et rang, jamais un
    // chemin disque.
    const audio = blocs[0]?.querySelector('audio');
    expect(audio?.hasAttribute('controls')).toBe(true);
    expect(audio?.getAttribute('src')).toBe(
      '/api/runs/job-7/media?path=outputs%2Fvoix+off.wav&n=0',
    );
    expect(blocs[1]?.querySelector('img')?.getAttribute('src')).toBe(
      '/api/runs/job-7/media?path=outputs%2Fcover.png&n=0',
    );
    expect(blocs[2]?.querySelector('video')?.hasAttribute('controls')).toBe(true);

    // Télécharger : un vrai lien de téléchargement, pas une navigation.
    const telecharger = blocs[0]?.querySelector('a[download]');
    expect(telecharger?.getAttribute('href')).toBe(
      '/api/runs/job-7/media?path=outputs%2Fvoix+off.wav&n=0&download=1',
    );
    expect(telecharger?.getAttribute('aria-label')).toBe('Download');

    // La rangée garde le geste et le chemin, comme une plaque.
    expect(blocs[0]?.textContent).toContain('written');
    expect(blocs[0]?.textContent).toContain('outputs/voix off.wav');

    // Le fichier de code garde SA plaque de diff, et les médias n'en ont pas.
    const plaques = [...container.querySelectorAll('[data-testid="file-change-kind"]')];
    expect(plaques).toHaveLength(1);
    expect(plaques[0]?.closest('button')?.textContent).toContain('src/a.ts');
    // Rien n'a été demandé pour les fragments : un média ne les déclenche pas.
    expect(getRunFileChangesAction).not.toHaveBeenCalled();
  });

  it('deux médias au même chemin affiché demandent chacun le sien, par leur rang', async () => {
    const masque = 'cles/[secret].wav';
    await render(
      <DeliveryBlock
        summary={{
          ...EMPTY,
          files: 2,
          fileChanges: [
            { path: masque, addedLines: 0, removedLines: 0, changeKind: 'added' as const },
            { path: masque, addedLines: 0, removedLines: 0, changeKind: 'added' as const },
          ],
        }}
        jobId="job-7"
        filesJobId="job-7"
      />,
    );
    const srcs = [...container.querySelectorAll('audio')].map((a) => a.getAttribute('src'));
    expect(srcs).toEqual([
      '/api/runs/job-7/media?path=cles%2F%5Bsecret%5D.wav&n=0',
      '/api/runs/job-7/media?path=cles%2F%5Bsecret%5D.wav&n=1',
    ]);
  });

  it('un média que la route refuse DIT pourquoi, au lieu d’un lecteur muet', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'gone' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await render(<DeliveryBlock summary={MEDIAS} jobId="job-7" filesJobId="job-7" />);
      const audio = container.querySelector('audio');
      await act(async () => {
        audio?.dispatchEvent(new Event('error'));
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/runs/job-7/media?path=outputs%2Fvoix+off.wav&n=0',
        {
          headers: { Range: 'bytes=0-0' },
        },
      );
      const note = container.querySelector('[data-testid="delivery-media-failure"]');
      expect(note?.textContent).toBe('This file is no longer on disk.');
      // Le lecteur a laissé la place au motif ; les autres médias sont intacts.
      expect(container.querySelectorAll('audio')).toHaveLength(0);
      expect(container.querySelectorAll('img')).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('un fichier vide se dit vide (la route répond 416 sans corps)', async () => {
    // Revue de la PR #493 : la note disait « Cannot show this file (HTTP 416) ».
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 416 })),
    );
    try {
      await render(<DeliveryBlock summary={MEDIAS} jobId="job-7" filesJobId="job-7" />);
      await act(async () => {
        container.querySelector('audio')?.dispatchEvent(new Event('error'));
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(container.querySelector('[data-testid="delivery-media-failure"]')?.textContent).toBe(
        'This file is empty.',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

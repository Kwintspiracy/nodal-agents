// FolderPickerModal.test.tsx — la fenêtre de Browse… quand valider ATTACHE le
// dossier (#461, revue de la PR #467).
//
// Ce que ça prouve, sur le DOM rendu et sur les chemins remis à `onSelect` :
//   - un double clic sur « Select this folder » ne remet le dossier qu'UNE
//     fois — deux remises, c'étaient deux insertions, la seconde en conflit ;
//   - la fenêtre s'ouvre sur `startPath` (le dossier d'un ajout refusé), pas
//     sur les racines ;
//   - un `startPath` disparu retombe sur les racines EN LE DISANT.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Listing = {
  path: string | null;
  parent: string | null;
  home: string;
  dirs: { name: string; path: string }[];
  truncated: boolean;
};

const ROOTS: Listing = {
  path: null,
  parent: null,
  home: '/home/ada',
  dirs: [{ name: 'home', path: '/home' }],
  truncated: false,
};
const NOTES: Listing = {
  path: '/backup/notes',
  parent: '/backup',
  home: '/home/ada',
  dirs: [],
  truncated: false,
};

const actions = vi.hoisted(() => ({
  browseServerFoldersAction: vi.fn(
    async (
      _path: string | null,
    ): Promise<{ ok: true; data: Listing } | { ok: false; code: string; message: string }> => ({
      ok: false,
      code: 'unset',
      message: 'unset',
    }),
  ),
}));

vi.mock('@/lib/actions.ts', () => actions);

const { default: FolderPickerModal } = await import('../FolderPickerModal.tsx');

let container: HTMLDivElement;
let root: Root;

function serve(listings: Record<string, Listing>) {
  actions.browseServerFoldersAction.mockImplementation(async (path) => {
    const hit = listings[path ?? '<roots>'];
    return hit
      ? { ok: true as const, data: hit }
      : { ok: false as const, code: 'not_found', message: `${path} does not exist` };
  });
}

async function render(props: {
  startPath?: string | null;
  onSelect: (path: string) => void | Promise<void>;
}): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<FolderPickerModal open onClose={() => {}} {...props} />);
  });
  // L'ouverture navigue dans une microtâche, puis l'action se résout.
  await act(async () => {});
  await act(async () => {});
}

function selectButton(): HTMLButtonElement {
  const b = Array.from(document.body.querySelectorAll('button')).find((x) =>
    /Select this folder|Adding…/.test(x.textContent ?? ''),
  );
  if (!b) throw new Error('no select button');
  return b as HTMLButtonElement;
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  actions.browseServerFoldersAction.mockReset();
});

describe('FolderPickerModal @cap:travailler-sur-des-fichiers/ecran', () => {
  it('un double clic ne remet le dossier qu’une fois', async () => {
    serve({ '<roots>': ROOTS, '/backup/notes': NOTES });
    const recus: string[] = [];
    let finir: () => void = () => {};
    await render({
      startPath: '/backup/notes',
      onSelect: (path) => {
        recus.push(path);
        return new Promise<void>((r) => (finir = r));
      },
    });

    await act(async () => {
      selectButton().click();
      selectButton().click();
    });
    expect(selectButton().textContent).toBe('Adding…');
    expect(selectButton().disabled).toBe(true);
    await act(async () => finir());

    expect(recus).toEqual(['/backup/notes']);
  });

  it('s’ouvre sur startPath, pas sur les racines', async () => {
    serve({ '<roots>': ROOTS, '/backup/notes': NOTES });
    const recus: string[] = [];
    await render({ startPath: '/backup/notes', onSelect: (p) => void recus.push(p) });

    expect(document.body.textContent).toContain('/backup/notes');
    await act(async () => selectButton().click());
    expect(recus).toEqual(['/backup/notes']);
  });

  it('un startPath disparu : les racines, et le dire', async () => {
    serve({ '<roots>': ROOTS });
    await render({ startPath: '/backup/gone', onSelect: () => {} });

    expect(document.body.textContent).toContain(
      '/backup/gone can no longer be opened. Pick the folder again.',
    );
    // Les racines sont listées : on peut repartir de là.
    expect(document.body.textContent).toContain('Drives');
  });
});

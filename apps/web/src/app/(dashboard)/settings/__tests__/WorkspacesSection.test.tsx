// WorkspacesSection.test.tsx — LA TAILLE ET LE COÛT DU FILET À L'ÉCRAN (#261).
//
// @cap:travailler-sur-des-fichiers/ecran
//
// Le moteur est prouvé ailleurs (`lib/__tests__/workspace-footprint.test.ts` :
// la mesure lit de vrais octets, la durée remonte, une absence se dit). Ce qui
// se prouve ICI est l'autre moitié : les deux faits ARRIVENT sous les yeux, à
// côté du bon espace, et l'écran ne fait jamais passer une absence pour un
// zéro.
//
// CE QU'IL PROUVE :
//   1. la ligne d'un espace porte sa taille et la durée de sa dernière photo ;
//   2. tant que la lecture n'a pas répondu, l'écran DIT qu'il mesure — il ne
//      montre pas un vide qui se lirait « rien » ;
//   3. un comptage arrêté avant la fin s'affiche « At least », jamais la taille
//      nue ;
//   4. une lecture en échec se DIT sous la ligne, elle ne disparaît pas ;
//   5. un TRANSPORT qui casse le dit aussi — l'action n'attrape que ses
//      propres erreurs, pas une promesse rejetée.
//
// Mutations vérifiées :
//   - l'appel à `listWorkspaceFootprintsAction` retiré de l'effet → les points
//     1 et 3 rougissent (l'écran reste sur « Measuring… ») ;
//   - le message d'erreur remplacé par une chaîne vide → le point 4 rougit ;
//   - le `.catch` retiré de l'effet → le point 5 rougit (la ligne reste sur
//     « Measuring… »).

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('sonner', () => ({ toast: { success: () => {}, error: () => {} } }));
vi.mock('@/lib/actions.ts', () => ({
  listWorkspacesAction: vi.fn(),
  createWorkspaceAction: vi.fn(),
  renameWorkspaceAction: vi.fn(),
  deleteWorkspaceAction: vi.fn(),
  switchWorkspaceAction: vi.fn(),
}));
vi.mock('@/lib/workspace-footprint-actions.ts', () => ({
  listWorkspaceFootprintsAction: vi.fn(),
}));

import WorkspacesSection from '../WorkspacesSection.tsx';
import { listWorkspaceFootprintsAction } from '@/lib/workspace-footprint-actions.ts';
import type { WorkspaceFootprint } from '@/lib/workspace-footprint-actions.ts';
import type { WorkspaceRow } from '@/lib/actions.ts';

const ESPACE: WorkspaceRow = {
  id: 'w-1',
  name: 'Atelier',
  slug: 'atelier',
  icon: null,
  role: 'owner',
  active: true,
};

let container: HTMLDivElement;
let root: Root;

/** Ce que l'écran écrit sous le nom d'un espace. */
function empreinte(id: string): string {
  const el = container.querySelector<HTMLElement>(`[data-testid="workspace-footprint-${id}"]`);
  if (!el) throw new Error(`aucune ligne d’empreinte pour ${id}`);
  return el.textContent ?? '';
}

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(WorkspacesSection, { initial: [ESPACE] }));
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.mocked(listWorkspaceFootprintsAction).mockReset();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
});

describe('la taille d’un espace à l’écran @cap:travailler-sur-des-fichiers/ecran', () => {
  it('écrit la taille lue et la durée de la dernière photo', async () => {
    const vu: WorkspaceFootprint = {
      workspaceId: ESPACE.id,
      path: 'C:/nodal/w-1/shared',
      measure: { bytes: 1536, files: 2, capped: false, sizeLabel: '1.5 KB' },
      unmeasured: null,
      lastSnapshot: {
        ms: 24_130,
        takenAt: new Date('2026-09-20T12:00:00Z'),
        workspace: 'C:/nodal/w-1/shared',
      },
    };
    vi.mocked(listWorkspaceFootprintsAction).mockResolvedValue({ ok: true, data: [vu] });

    await render();

    const texte = empreinte(ESPACE.id);
    expect(texte).toContain('1.5 KB in 2 files');
    // LA DURÉE, celle qu'on regarde monter vers la borne de 30 s de `git add`.
    expect(texte).toContain('Last snapshot took 24.1 s');
  });

  it('dit le PLANCHER quand le comptage s’est arrêté avant la fin', async () => {
    const vu: WorkspaceFootprint = {
      workspaceId: ESPACE.id,
      path: 'C:/nodal/w-1/shared',
      measure: { bytes: 3_543_348_428, files: 50_000, capped: true, sizeLabel: '3.3 GB' },
      unmeasured: null,
      lastSnapshot: null,
    };
    vi.mocked(listWorkspaceFootprintsAction).mockResolvedValue({ ok: true, data: [vu] });

    await render();

    const texte = empreinte(ESPACE.id);
    // « At least » : le comptage n'est pas allé au bout, la taille est un
    // minorant, et l'écrire nue ferait croire que le dossier ne pèse pas plus.
    expect(texte).toContain('At least 3.3 GB in 50000 files');
    expect(texte).toContain('No safety snapshot yet');
  });

  it('dit qu’il MESURE tant que la lecture n’a pas répondu', async () => {
    // Une promesse qui ne se résout pas : c'est l'état que la personne voit
    // pendant les trois secondes de la mesure. Un vide s'y lirait « rien ».
    vi.mocked(listWorkspaceFootprintsAction).mockReturnValue(new Promise(() => {}));

    await render();

    expect(empreinte(ESPACE.id)).toContain('Measuring shared folder');
  });

  it('DIT un transport qui casse, au lieu de mesurer pour toujours', async () => {
    // L'action attrape ses PROPRES erreurs et rend `fail()` ; elle n'attrape
    // pas celles du transport. Réseau coupé, serveur muet : la promesse est
    // rejetée, et sans `catch` la ligne restait sur « Measuring… » sans jamais
    // rien dire (revue C, passe 1, constat C2).
    vi.mocked(listWorkspaceFootprintsAction).mockRejectedValue(new Error('fetch failed'));

    await render();

    const texte = empreinte(ESPACE.id);
    expect(texte).toContain('Could not reach the server');
    expect(texte, 'la ligne mesure encore').not.toContain('Measuring');
  });

  it('DIT une lecture en échec, au lieu de laisser la ligne muette', async () => {
    vi.mocked(listWorkspaceFootprintsAction).mockResolvedValue({
      ok: false,
      code: 'db_error',
      message: 'Failed to read the workspace sizes',
    });

    await render();

    expect(empreinte(ESPACE.id)).toContain('Failed to read the workspace sizes');
  });
});

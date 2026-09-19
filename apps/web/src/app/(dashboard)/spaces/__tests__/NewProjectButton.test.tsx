// NewProjectButton.test.tsx — la case « git » du formulaire de création
// (issue #200).
//
// Ce qui se prouve : que la case existe, qu'elle est DÉCOCHÉE d'entrée, et que
// ce que le formulaire envoie suit ce que la personne a coché. Poser un dépôt
// écrit dans son dossier — une case cochée d'office serait un geste pris à sa
// place, et l'assertion qui compte est donc celle sur l'ARGUMENT ENVOYÉ, pas
// sur la présence d'un carré à l'écran.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import NewProjectButton from '../NewProjectButton.tsx';

const createProjectAction = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true as const, data: { id: 'p1', path: 'D:/terrain/projet' } })),
);
const listProjectTerrainsAction = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true as const,
    data: [
      {
        agentId: 'a1',
        agentName: 'Dev',
        workspaces: [{ id: 'w1', label: 'terrain', path: 'D:/terrain' }],
      },
    ],
  })),
);

vi.mock('@/lib/project-actions.ts', () => ({ createProjectAction, listProjectTerrainsAction }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('sonner', () => ({ toast: { success: () => {}, error: () => {} } }));

/**
 * jsdom ne fournit pas `CSS.supports`, que le `Select` du design system
 * interroge au montage pour savoir s'il peut styler ses `optgroup`. Sans ce
 * bouchon, la modale ne monte pas du tout — et l'échec ne dit rien de la case
 * qu'on vient vérifier. `false` = le chemin sans `base-select`, celui de tous
 * les navigateurs qui ne l'ont pas.
 */
const cssStub = { supports: () => false } as unknown as typeof globalThis.CSS;
if (typeof globalThis.CSS?.supports !== 'function') {
  Object.defineProperty(globalThis, 'CSS', { value: cssStub, configurable: true });
}

let container: HTMLDivElement;
let root: Root;

async function ouvrirLaModale(): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<NewProjectButton />);
  });
  const bouton = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent === 'New project',
  );
  await act(async () => {
    bouton?.click();
  });
}

/** La case git, retrouvée par son étiquette — comme on la retrouve à l'œil. */
function caseGit(): HTMLInputElement | null {
  const label = Array.from(document.querySelectorAll('label')).find((l) =>
    (l.textContent ?? '').includes('Initialise git in this folder'),
  );
  return label?.querySelector('input[type="checkbox"]') ?? null;
}

function champ(etiquette: string): HTMLInputElement | null {
  const label = Array.from(document.querySelectorAll('label')).find(
    (l) => l.textContent === etiquette,
  );
  const id = label?.getAttribute('for');
  const el = id ? document.getElementById(id) : null;
  return el instanceof HTMLInputElement ? el : null;
}

beforeEach(() => {
  createProjectAction.mockClear();
  listProjectTerrainsAction.mockClear();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('NewProjectButton — la case git @cap:travailler-sur-des-fichiers/ecran', () => {
  it('la case existe et elle est DÉCOCHÉE', async () => {
    await ouvrirLaModale();

    const c = caseGit();
    expect(c).not.toBeNull();
    expect(c?.checked).toBe(false);
    expect(document.body.textContent).toContain('Nothing is committed and nothing is pushed');
  });

  it('sans la cocher, la création ne demande AUCUN dépôt', async () => {
    await ouvrirLaModale();

    const nom = champ('Name');
    await act(async () => {
      if (nom) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(nom, 'Mon projet');
        nom.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    const creer = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Create project',
    );
    await act(async () => {
      creer?.click();
    });

    expect(createProjectAction).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Mon projet', initGit: false }),
    );
  });

  it('cochée, la création demande le dépôt', async () => {
    await ouvrirLaModale();

    const nom = champ('Name');
    await act(async () => {
      if (nom) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(nom, 'Mon projet');
        nom.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await act(async () => {
      caseGit()?.click();
    });
    const creer = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Create project',
    );
    await act(async () => {
      creer?.click();
    });

    expect(createProjectAction).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Mon projet', initGit: true }),
    );
  });
});

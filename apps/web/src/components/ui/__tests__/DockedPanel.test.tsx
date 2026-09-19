// DockedPanel.test.tsx — le panneau ancré au bord droit (DS, #231).
//
// Ce qui se prouve, et pourquoi chaque fait est là :
//   1. fermé, le composant ne laisse RIEN dans le DOM — un panneau qui ne
//      rend qu'une enveloppe invisible pousserait quand même la page ;
//   2. ouvert, il rend son titre, son corps, et un bouton de fermeture qui
//      rappelle l'appelant ;
//   3. Échap ferme quand il est ouvert, et NE FERME PAS quand il est fermé
//      (l'écouteur est retiré) — sinon un Échap destiné à autre chose
//      rappellerait `onClose` d'un panneau déjà parti ;
//   4. le pied est optionnel : absent, aucune barre d'actions n'est rendue ;
//   5. il n'y a AUCUN voile : le contenu de la page reste cliquable à côté du
//      panneau. C'est la différence avec `Drawer` et `Modal`, et la promesse
//      de la planche P1 — donc elle s'assert, elle ne se documente pas.
//
// Rendu dans jsdom et MANIPULÉ : les assertions portent sur le DOM produit et
// sur ce que l'appelant REÇOIT (`onClose`), jamais sur un compte d'appels seul.
//
// Mutations vérifiées (chacune fait rougir au moins un cas) :
//   - `if (!open) return null` retiré → le cas « fermé » rougit ;
//   - l'effet Échap sans sa garde `if (!open) return` → le cas « fermé,
//     Échap ne rappelle pas » rougit ;
//   - `footer !== undefined` remplacé par `true` → le cas « sans pied » rougit.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import DockedPanel from '../DockedPanel.tsx';

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

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

function panel(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-testid="panel"]');
  if (!el) throw new Error('aucun panneau rendu');
  return el;
}

describe('DockedPanel', () => {
  it('fermé, il ne laisse rien dans le DOM', async () => {
    await render(
      <DockedPanel open={false} onClose={() => {}} title="Network access" testId="panel">
        <p>corps</p>
      </DockedPanel>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('ouvert, il rend son titre et son corps', async () => {
    await render(
      <DockedPanel open onClose={() => {}} title="Network access" testId="panel">
        <p data-testid="corps">Control which devices can reach the dashboard.</p>
      </DockedPanel>,
    );
    expect(panel().querySelector('h2')?.textContent).toBe('Network access');
    expect(panel().querySelector('[data-testid="corps"]')?.textContent).toBe(
      'Control which devices can reach the dashboard.',
    );
  });

  it('le bouton de fermeture rappelle l’appelant', async () => {
    const onClose = vi.fn();
    await render(
      <DockedPanel open onClose={onClose} title="Network access" testId="panel">
        <p>corps</p>
      </DockedPanel>,
    );
    const bouton = panel().querySelector('button[aria-label="Close"]');
    expect(bouton).not.toBeNull();
    await click(bouton!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Échap ferme le panneau ouvert, et le panneau disparaît vraiment', async () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <DockedPanel open={open} onClose={() => setOpen(false)} title="Timezone" testId="panel">
          <p>corps</p>
        </DockedPanel>
      );
    }
    await render(<Host />);
    expect(container.querySelector('[data-testid="panel"]')).not.toBeNull();
    await pressEscape();
    expect(container.querySelector('[data-testid="panel"]')).toBeNull();
  });

  it('fermé, Échap ne rappelle pas l’appelant', async () => {
    const onClose = vi.fn();
    await render(
      <DockedPanel open={false} onClose={onClose} title="Timezone" testId="panel">
        <p>corps</p>
      </DockedPanel>,
    );
    await pressEscape();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('sans pied, aucune barre d’actions n’est rendue', async () => {
    await render(
      <DockedPanel open onClose={() => {}} title="Install notes" testId="panel">
        <p>corps</p>
      </DockedPanel>,
    );
    // Pas de barre d'actions du tout — ni vide, ni avec son trait.
    expect(panel().querySelector('[data-slot="footer"]')).toBeNull();
    // Le seul bouton du panneau est celui de fermeture.
    expect(panel().querySelectorAll('button')).toHaveLength(1);
  });

  it('avec un pied, ses actions sont rendues sous le corps', async () => {
    await render(
      <DockedPanel
        open
        onClose={() => {}}
        title="Network access"
        testId="panel"
        footer={
          <div data-testid="pied">
            <button type="button">Cancel</button>
            <button type="button">Save</button>
          </div>
        }
      >
        <p data-testid="corps">corps</p>
      </DockedPanel>,
    );
    const pied = panel().querySelector('[data-slot="footer"]');
    expect(pied).not.toBeNull();
    expect(pied!.querySelector('[data-testid="pied"]')).not.toBeNull();
    const corps = panel().querySelector('[data-testid="corps"]')!;
    // Le pied vient APRÈS le corps dans le document.
    expect(corps.compareDocumentPosition(pied!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('il pousse la page au lieu de la couvrir : aucun voile, la page reste cliquable', async () => {
    const onPageClick = vi.fn();
    await render(
      <div className="flex">
        <main>
          <button type="button" data-testid="page-bouton" onClick={onPageClick}>
            Une ligne de la page
          </button>
        </main>
        <DockedPanel open onClose={() => {}} title="Network access" testId="panel">
          <p>corps</p>
        </DockedPanel>
      </div>,
    );
    // Pas de conteneur plein écran posé par-dessus la page.
    expect(container.querySelector('.fixed')).toBeNull();
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    // Et la page répond toujours au clic.
    await click(container.querySelector('[data-testid="page-bouton"]')!);
    expect(onPageClick).toHaveBeenCalledTimes(1);
  });

  it('la largeur est posée par l’appelant, 400 px par défaut', async () => {
    await render(
      <DockedPanel open onClose={() => {}} title="A" testId="panel">
        <p>corps</p>
      </DockedPanel>,
    );
    expect(panel().style.width).toBe('400px');
    await act(async () => {
      root.render(
        <DockedPanel open onClose={() => {}} title="A" width={520} testId="panel">
          <p>corps</p>
        </DockedPanel>,
      );
    });
    expect(panel().style.width).toBe('520px');
  });
});

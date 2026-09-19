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
//      de la planche P1 — donc elle s'assert, elle ne se documente pas ;
//   6. le panneau ouvert sous un autre calque ne prend PAS Échap à sa place.
//      Ce qui décide entre plusieurs calques est un protocole partagé, pas une
//      affaire de ce composant : il vit dans `@/lib/layers.ts` et se prouve
//      dans `src/lib/__tests__/layers.test.tsx`, sur les vrais calques.
//
// Échap part de `document.body`, jamais de `window` : c'est le vrai chemin
// d'une touche dans un navigateur, la cible étant l'élément focalisé.
//
// Rendu dans jsdom et MANIPULÉ : les assertions portent sur le DOM produit et
// sur ce que l'appelant REÇOIT (`onClose`), jamais sur un compte d'appels seul.
//
// Mutations vérifiées (chacune fait rougir au moins un cas) :
//   - `if (!open) return null` retiré → le cas « fermé » rougit ;
//   - l'effet Échap sans sa garde `if (!open) return` → le cas « fermé,
//     Échap ne rappelle pas » rougit ;
//   - `footer !== undefined` remplacé par `true` → le cas « sans pied » rougit ;
//   - le panneau qui n'entrerait plus dans la pile des calques → le cas
//     « sous une modale, Échap ne ferme pas le panneau » rougit ;
//   - le trait gauche repassé à `rule-2` → le cas des deux traits rougit.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import DockedPanel from '../DockedPanel.tsx';
import Modal from '../Modal.tsx';

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

/**
 * Échap comme dans un navigateur : depuis l'élément focalisé, pas `window`, et
 * ANNULABLE.
 *
 * `cancelable: true` n'est pas un détail : `preventDefault()` ne pose
 * `defaultPrevented` que sur un événement annulable, et il vaut `false` par
 * défaut dans le constructeur. Sans lui, toute la politesse entre calques est
 * muette dans le test alors qu'elle marche dans un navigateur, où un vrai
 * `keydown` est annulable.
 */
async function pressEscape(): Promise<void> {
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
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
    //
    // La garde est un HEURISTIQUE sur le nom de classe : un `position: fixed`
    // posé autrement (style en ligne, classe calculée) lui échapperait. Elle
    // tient tant que la source reste ce qu'elle est — une seule chaîne de
    // classes littérale, lisible d'un coup d'œil juste au-dessus. Le fait qui
    // compte vraiment est le suivant, et lui ne se contourne pas : la page
    // répond au clic.
    expect(container.querySelector('.fixed')).toBeNull();
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    // Et la page répond toujours au clic.
    await click(container.querySelector('[data-testid="page-bouton"]')!);
    expect(onPageClick).toHaveBeenCalledTimes(1);
  });

  it('sous une modale ouverte depuis lui, Échap ne ferme pas le panneau', async () => {
    // Ce que ce fichier doit dire du panneau, et rien de plus : il n'attrape
    // pas la touche d'un calque ouvert au-dessus de lui. Qui l'attrape, et
    // dans quel ordre, se prouve dans `src/lib/__tests__/layers.test.tsx`.
    function Empile() {
      const [panelOpen, setPanelOpen] = useState(true);
      const [modalOpen, setModalOpen] = useState(false);
      return (
        <DockedPanel
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
          title="Network access"
          testId="panel"
        >
          <button type="button" data-testid="ouvrir" onClick={() => setModalOpen(true)}>
            Ouvrir la modale
          </button>
          <Modal
            open={modalOpen}
            onClose={() => setModalOpen(false)}
            title="Confirm"
            testId="modale"
          >
            <p>contenu</p>
          </Modal>
        </DockedPanel>
      );
    }
    await render(<Empile />);
    await click(container.querySelector('[data-testid="ouvrir"]')!);
    expect(document.body.querySelector('[data-testid="modale"]')).not.toBeNull();

    await pressEscape();
    expect(document.body.querySelector('[data-testid="modale"]'), 'la modale part').toBeNull();
    expect(container.querySelector('[data-testid="panel"]'), 'le panneau reste').not.toBeNull();
  });

  it('le trait gauche sépare deux surfaces, les traits intérieurs découpent', async () => {
    // `rule` à gauche, `rule-2` dedans. En thème sombre, un `rule-2` à gauche
    // laissait le panneau se confondre avec la page (constat de Quentin).
    await render(
      <DockedPanel
        open
        onClose={() => {}}
        title="Network access"
        testId="panel"
        footer={<span data-testid="pied">actions</span>}
      >
        <p>corps</p>
      </DockedPanel>,
    );
    const classes = [...panel().classList];
    expect(classes, 'le trait gauche est le jeton fort').toContain('border-rule');
    expect(classes, 'et pas le faible').not.toContain('border-rule-2');

    // L'en-tête et le pied, eux, découpent la même surface.
    const entete = panel().querySelector('h2')!.closest('div')!;
    expect([...entete.classList]).toContain('border-rule-2');
    const pied = panel().querySelector('[data-slot="footer"]')!;
    expect([...pied.classList]).toContain('border-rule-2');
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

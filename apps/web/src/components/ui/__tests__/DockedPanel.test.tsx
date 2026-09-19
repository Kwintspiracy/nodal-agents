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
//   6. la POLITESSE entre calques (revue #233) : une modale ouverte prend
//      Échap, et le panneau dessous ne se ferme pas avec elle. C'est le seul
//      cas où deux calques se parlent, donc il se prouve.
//
// Échap part de `document.body`, jamais de `window` : c'est le vrai chemin
// d'une touche dans un navigateur (la cible est l'élément focalisé), et c'est
// ce chemin-là qui fait passer la CAPTURE avant la BULLE. Envoyé sur `window`
// même, l'événement est AT_TARGET et les écouteurs repartent dans leur ordre
// d'inscription — le test serait vert sur une coordination qui ne marche pas.
//
// Rendu dans jsdom et MANIPULÉ : les assertions portent sur le DOM produit et
// sur ce que l'appelant REÇOIT (`onClose`), jamais sur un compte d'appels seul.
//
// Mutations vérifiées (chacune fait rougir au moins un cas) :
//   - `if (!open) return null` retiré → le cas « fermé » rougit ;
//   - l'effet Échap sans sa garde `if (!open) return` → le cas « fermé,
//     Échap ne rappelle pas » rougit ;
//   - `footer !== undefined` remplacé par `true` → le cas « sans pied » rougit ;
//   - la garde `e.defaultPrevented` retirée du panneau → les deux cas
//     « sous une modale » rougissent ;
//   - la `Modal` non-dismissable qui ne prend plus la touche → le cas
//     « sous une modale non-dismissable » rougit ;
//   - la `Modal` remise en phase de BULLE → le cas « modale sœur » rougit, et
//     lui seul : c'est exactement ce que la capture achète.

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

  /**
   * Le panneau est ouvert D'ABORD, la modale ensuite, par un clic — le vrai
   * enchaînement d'un formulaire ouvert DANS le panneau.
   *
   * Ce cas-là ne prouve pas à lui seul la phase de capture : la modale est un
   * ENFANT du panneau, et React exécute les effets de l'enfant avant ceux du
   * parent, donc elle s'inscrit la première de toute façon. C'est le cas
   * « modale sœur » plus bas qui prouve la capture.
   */
  function Empile({ dismissable }: { dismissable: boolean }) {
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
          dismissable={dismissable}
          title="Confirm"
          testId="modale"
        >
          <p>contenu</p>
        </Modal>
      </DockedPanel>
    );
  }

  it('sous une modale non-dismissable ouverte depuis lui, Échap ne ferme pas le panneau', async () => {
    await render(<Empile dismissable={false} />);
    await click(container.querySelector('[data-testid="ouvrir"]')!);
    expect(document.body.querySelector('[data-testid="modale"]')).not.toBeNull();

    await pressEscape();

    // La modale a PRIS la touche sans se fermer : les deux sont encore là.
    expect(document.body.querySelector('[data-testid="modale"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="panel"]')).not.toBeNull();
  });

  it('sous une modale ordinaire, un Échap ferme la modale, le suivant le panneau', async () => {
    await render(<Empile dismissable />);
    await click(container.querySelector('[data-testid="ouvrir"]')!);
    expect(document.body.querySelector('[data-testid="modale"]')).not.toBeNull();

    await pressEscape();
    expect(document.body.querySelector('[data-testid="modale"]')).toBeNull();
    expect(container.querySelector('[data-testid="panel"]')).not.toBeNull();

    // Le second Échap, lui, revient au panneau.
    await pressEscape();
    expect(container.querySelector('[data-testid="panel"]')).toBeNull();
  });

  it('une modale SŒUR, montée après, prend quand même Échap avant le panneau', async () => {
    // Le cas qui prouve la phase de CAPTURE, et lui seul.
    //
    // Ici la modale n'est pas dans le panneau : c'est une sœur, montée plus
    // tard. Les effets partent alors dans l'ordre de l'arbre — le panneau
    // s'inscrit AVANT elle. En phase de bulle il parlerait le premier et se
    // fermerait ; seule la capture fait passer la modale devant.
    function Cote() {
      const [panelOpen, setPanelOpen] = useState(true);
      const [modalOpen, setModalOpen] = useState(false);
      return (
        <div>
          <DockedPanel
            open={panelOpen}
            onClose={() => setPanelOpen(false)}
            title="Network access"
            testId="panel"
          >
            <p>corps</p>
          </DockedPanel>
          <button type="button" data-testid="ouvrir" onClick={() => setModalOpen(true)}>
            Ouvrir
          </button>
          {modalOpen && (
            <Modal open onClose={() => {}} dismissable={false} title="Confirm" testId="modale">
              <p>contenu</p>
            </Modal>
          )}
        </div>
      );
    }

    await render(<Cote />);
    await click(container.querySelector('[data-testid="ouvrir"]')!);
    expect(document.body.querySelector('[data-testid="modale"]')).not.toBeNull();

    await pressEscape();

    expect(container.querySelector('[data-testid="panel"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="modale"]')).not.toBeNull();
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

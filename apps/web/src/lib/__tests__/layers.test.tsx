// layers.test.tsx — QUI prend Échap quand plusieurs calques sont ouverts (#233).
//
// Ce qui se prouve, et pourquoi ce fichier existe séparément : la règle n'est
// pas celle d'un composant, c'est un PROTOCOLE entre eux. Les cas ci-dessous
// montent donc les VRAIS calques — `Modal`, `AvatarPicker`, `DockedPanel` —
// et pressent une vraie touche, plutôt que de tester la pile à vide.
//
// La régression qui a fait écrire tout ça (revue #233, passe 2) : une `Modal`
// `dismissable={false}` prenait Échap sans se fermer, donc le popover d'avatar
// ouvert DANS elle ne le recevait plus. Sur Agents › Modifier un agent, Échap
// ne fermait plus rien. Le premier cas ci-dessous est exactement ce parcours.
//
// Échap part de `document.body`, ANNULABLE : c'est le vrai chemin d'une touche
// dans un navigateur. Un `KeyboardEvent` construit à la main n'est pas
// annulable par défaut, et `preventDefault()` n'y ferait rien.
//
// Mutations vérifiées :
//   - la pile lue à l'envers (`stack[0]` au lieu du dernier) → le cas « le
//     popover dans une modale non-dismissable » rougit ;
//   - le `preventDefault()` retiré → rien ne rougit ici, et c'est normal :
//     plus aucun autre écouteur ne lit la touche. Il protège les écouteurs
//     hors de la pile, pas les calques entre eux.
//   - une modale non-dismissable qui s'inscrirait avec `onClose` au lieu du
//     geste vide → le cas « seule, elle ne se ferme pas » rougit.

import { describe, it, expect, afterEach } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Modal from '@/components/ui/Modal.tsx';
import AvatarPicker from '@/components/AvatarPicker.tsx';
import DockedPanel from '@/components/ui/DockedPanel.tsx';
import PrimaryButton from '@/components/ui/PrimaryButton.tsx';
import { openLayerCount } from '../layers.ts';

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
  // Aucun calque ne doit survivre à son composant.
  expect(openLayerCount(), 'la pile de calques est vide après démontage').toBe(0);
});

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
}

/** Le popover d'avatar, rendu par portail dans `<body>`. */
function picker(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[aria-label="Pick an avatar"]');
}

/**
 * Le bouton qui ouvre ce popover — cherché DANS TOUT LE DOCUMENT et par son
 * texte : selon le cas il vit dans le conteneur (sous un panneau) ou dans un
 * portail (sous une modale), et il côtoie d'autres boutons.
 */
function pickerTrigger(): HTMLElement {
  const el = [...document.body.querySelectorAll<HTMLElement>('button')].find((b) =>
    b.textContent?.includes('No avatar'),
  );
  if (!el) throw new Error('aucun déclencheur rendu');
  return el;
}

function modal(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-testid="modale"]');
}

describe('Échap va au calque ouvert le plus intérieur', () => {
  it('dans une modale NON-DISMISSABLE, le popover ouvert dedans se ferme, la modale reste', async () => {
    // Le parcours exact de la régression : Agents › Modifier un agent
    // (`dismissable={false}`) › ouvrir le choix d'avatar › Échap.
    await render(
      <Modal open onClose={() => {}} dismissable={false} title="Edit agent" testId="modale">
        <AvatarPicker value={null} onChange={() => {}} />
      </Modal>,
    );
    await click(pickerTrigger());
    expect(picker(), 'le popover est ouvert').not.toBeNull();

    await pressEscape();

    expect(picker(), 'le popover se ferme').toBeNull();
    expect(modal(), 'la modale reste ouverte').not.toBeNull();
  });

  it('seule, une modale non-dismissable absorbe Échap sans se fermer', async () => {
    // `onClose` FERME vraiment : sinon le cas serait vert même si la modale
    // s'inscrivait avec son `onClose` au lieu du geste vide, et il ne
    // prouverait rien de l'absorption.
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          dismissable={false}
          title="Edit agent"
          testId="modale"
        >
          <p>rien ne se ferme d’ici</p>
        </Modal>
      );
    }
    await render(<Host />);
    await pressEscape();
    expect(modal(), 'Échap ne ferme pas une modale non-dismissable').not.toBeNull();
  });

  it('sous un panneau ancré, une modale sœur ouverte après se ferme seule', async () => {
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
          <PrimaryButton type="button" data-testid="ouvrir" onClick={() => setModalOpen(true)}>
            Ouvrir
          </PrimaryButton>
          {modalOpen && (
            <Modal open onClose={() => setModalOpen(false)} title="Confirm" testId="modale">
              <p>contenu</p>
            </Modal>
          )}
        </div>
      );
    }
    await render(<Cote />);
    await click(container.querySelector('[data-testid="ouvrir"]')!);
    expect(modal()).not.toBeNull();

    await pressEscape();
    expect(modal(), 'la modale se ferme').toBeNull();
    expect(container.querySelector('[data-testid="panel"]'), 'le panneau reste').not.toBeNull();

    // Le second Échap revient au panneau, devenu le calque du dessus.
    await pressEscape();
    expect(container.querySelector('[data-testid="panel"]')).toBeNull();
  });

  it('un panneau et un popover : le DERNIER ouvert se ferme le premier', async () => {
    // Deux calques non modaux ouverts ensemble — le cas que l'ancienne
    // convention laissait non dit.
    function Host() {
      const [panelOpen, setPanelOpen] = useState(true);
      return (
        <DockedPanel
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
          title="Agent"
          testId="panel"
        >
          <AvatarPicker value={null} onChange={() => {}} />
        </DockedPanel>
      );
    }
    await render(<Host />);
    await click(pickerTrigger());
    expect(picker()).not.toBeNull();

    await pressEscape();
    expect(picker(), 'le popover, ouvert en dernier, part le premier').toBeNull();
    expect(container.querySelector('[data-testid="panel"]'), 'le panneau reste').not.toBeNull();

    await pressEscape();
    expect(container.querySelector('[data-testid="panel"]'), 'puis le panneau').toBeNull();
  });

  it('un calque fermé quitte la pile, et la touche revient à celui du dessous', async () => {
    function Host() {
      const [panelOpen, setPanelOpen] = useState(true);
      const [modalOpen, setModalOpen] = useState(true);
      return (
        <div>
          <DockedPanel
            open={panelOpen}
            onClose={() => setPanelOpen(false)}
            title="A"
            testId="panel"
          >
            <p>corps</p>
          </DockedPanel>
          {modalOpen && (
            <PrimaryButton type="button" data-testid="fermer" onClick={() => setModalOpen(false)}>
              Fermer la modale
            </PrimaryButton>
          )}
          {modalOpen && (
            <Modal open onClose={() => setModalOpen(false)} title="M" testId="modale">
              <p>contenu</p>
            </Modal>
          )}
        </div>
      );
    }
    await render(<Host />);
    expect(openLayerCount()).toBe(2);

    // Fermée par son propre bouton, pas par Échap.
    await click(container.querySelector('[data-testid="fermer"]')!);
    expect(openLayerCount()).toBe(1);

    await pressEscape();
    expect(container.querySelector('[data-testid="panel"]')).toBeNull();
  });
});

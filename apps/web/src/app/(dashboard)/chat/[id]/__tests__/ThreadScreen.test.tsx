// ThreadScreen.test.tsx — la charpente d'un écran de conversation.
//
// Ce qui se prouve : le fil et la saisie sont centrés dans la MÊME largeur. Le
// fil porte la barre de défilement, la saisie non ; sans compensation, la
// saisie tombait d'une demi-barre à droite du fil (Quentin, 17/09/2026 : « une
// légère indentation à gauche par rapport au feed, et du coup il dépasse à
// droite »). Le fil publie sa gouttière dans `--thread-gutter`, la saisie se
// la réserve en marge droite, et le fil garde une gouttière STABLE pour ne pas
// se recentrer au premier débordement.
//
// Les noms de classe sont écrits EN DUR : un test qui lit la constante qu'il
// prouve reste vert quand on la change.

import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ThreadScreen from '../ThreadScreen.tsx';

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

describe('ThreadScreen @cap:parler-a-un-agent/ecran', () => {
  it('la saisie se réserve la gouttière du fil, et le fil la garde stable', async () => {
    await render(
      <ThreadScreen composer={<div data-testid="composer">la saisie</div>}>
        <p>le fil</p>
      </ThreadScreen>,
    );
    const scroller = container.querySelector('[data-thread-scroller]');
    if (!scroller) throw new Error('no scroller rendered');
    expect(scroller.className).toContain('[scrollbar-gutter:stable]');

    const slot = container.querySelector('[data-testid="composer"]')?.parentElement;
    if (!slot) throw new Error('no composer slot rendered');
    expect(slot.className).toContain('mr-[var(--thread-gutter,0px)]');
  });

  it('le fil s’éteint en fondu au-dessus de la saisie, sans bloquer le défilement', async () => {
    await render(
      <ThreadScreen composer={<div data-testid="composer">la saisie</div>}>
        <p>le fil</p>
      </ThreadScreen>,
    );
    const slot = container.querySelector('[data-testid="composer"]')?.parentElement;
    if (!slot) throw new Error('no composer slot rendered');
    // Le fondu vit DANS la fente de la saisie, juste au-dessus d'elle : il
    // suit donc sa largeur et sa gouttière sans un calcul de plus.
    const fade = slot.querySelector('[aria-hidden="true"]');
    if (!fade) throw new Error('no fade rendered above the composer');
    expect(fade.className).toContain('bottom-full');
    expect(fade.className).toContain('from-canvas');
    expect(fade.className).toContain('to-transparent');
    // Transparent aux clics : la molette et le doigt traversent.
    expect(fade.className).toContain('pointer-events-none');
    expect(slot.className).toContain('relative');
  });

  it('un fil suit le bas par défaut, et le dit dans le DOM', async () => {
    // La page d'un run demande l'inverse (`follow="never"`) ; sans défaut
    // explicite ici, les deux écrans auraient divergé en silence.
    await render(
      <ThreadScreen composer={<div>la saisie</div>}>
        <p>le fil</p>
      </ThreadScreen>,
    );
    expect(container.querySelector('[data-thread-scroller]')?.getAttribute('data-follow')).toBe(
      'bottom',
    );
  });

  it('un écran qui ne suit pas le bas le dit aussi', async () => {
    await render(
      <ThreadScreen follow="never">
        <p>le tableau</p>
      </ThreadScreen>,
    );
    expect(container.querySelector('[data-thread-scroller]')?.getAttribute('data-follow')).toBe(
      'never',
    );
  });

  it('le fil publie sa gouttière sur le parent, en pixels', async () => {
    await render(
      <ThreadScreen composer={<div>la saisie</div>}>
        <p>le fil</p>
      </ThreadScreen>,
    );
    // jsdom ne mesure rien : la gouttière vaut 0, et c'est écrit — la variable
    // existe dès la peinture, la saisie n'attend pas une première mesure.
    expect(container.style.getPropertyValue('--thread-gutter')).toBe('0px');
  });
});

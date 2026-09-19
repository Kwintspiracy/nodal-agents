// PageShell.test.tsx — la largeur de contenu d'une page, et un seul endroit
// où elle se décide (#237).
//
// Pourquoi ce fichier existe : `/settings` s'est retrouvée plus étroite que
// toutes les autres pages du produit, parce qu'elle posait sa propre borne sur
// sa colonne de liste. Quentin l'a vu à l'œil sur la stack. La correction n'a
// pas été d'enlever cette borne-là mais de faire porter la MÊME au `PageShell`
// dans ses deux modes, pour qu'aucune page n'ait plus de raison d'en poser
// une — c'est ce que ces cas tiennent.
//
// Le mode pleine hauteur a en plus une fente `aside`, qui vit HORS de la
// colonne bornée : un panneau ancré doit rester collé au bord de l'écran,
// alors qu'il flotterait au milieu s'il partageait la borne.
//
// L'ordre vertical compte aussi : en-tête, puis la zone `toolbar` PLEINE
// LARGEUR — c'est là que vit la WorkBar d'une page de détail, et une barre qui
// va d'un bord à l'autre ne peut pas vivre dans une colonne bornée (#243) —
// puis la rangée.
//
// Mutations vérifiées : la borne retirée du mode pleine hauteur → le cas
// « les deux modes portent la même borne » rougit ; l'`aside` rendu DANS la
// colonne de contenu → le cas « l'aside est hors de la borne » rougit ;
// `fluid` ignoré en mode pleine hauteur → le cas du plein cadre rougit ; la
// barre remise DANS la colonne bornée → le cas de l'ordre rougit.

import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PageShell from '../PageShell.tsx';

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

/** L'élément qui porte le corps, repéré par le contenu qu'on y a mis. */
function holder(testId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`${testId} absent`);
  return el.parentElement!;
}

/** La borne de largeur portée par un élément, ou `null`. */
function bound(el: HTMLElement): string | null {
  return [...el.classList].find((c) => c.startsWith('max-w-')) ?? null;
}

describe('PageShell — la largeur de contenu @cap:installer-et-demarrer/ecran', () => {
  it('les deux modes bornent la colonne de contenu à la même largeur', async () => {
    await render(
      <PageShell title="A">
        <p data-testid="corps">corps</p>
      </PageShell>,
    );
    const normal = bound(holder('corps'));

    await act(async () => {
      root.render(
        <PageShell title="A" fill>
          <p data-testid="corps">corps</p>
        </PageShell>,
      );
    });
    const pleineHauteur = bound(holder('corps'));

    expect(normal, 'le mode qui défile borne sa colonne').not.toBeNull();
    expect(pleineHauteur, 'le mode pleine hauteur aussi').toBe(normal);
  });

  it('`fluid` retire la borne dans les deux modes', async () => {
    await render(
      <PageShell title="A" fluid>
        <p data-testid="corps">corps</p>
      </PageShell>,
    );
    expect(bound(holder('corps'))).toBeNull();

    await act(async () => {
      root.render(
        <PageShell title="A" fill fluid>
          <p data-testid="corps">corps</p>
        </PageShell>,
      );
    });
    expect(bound(holder('corps'))).toBeNull();
  });

  it('l’aside se pose HORS de la colonne bornée, après elle', async () => {
    await render(
      <PageShell title="A" fill aside={<aside data-testid="panneau">panneau</aside>}>
        <p data-testid="corps">corps</p>
      </PageShell>,
    );
    const colonne = holder('corps');
    const panneau = container.querySelector<HTMLElement>('[data-testid="panneau"]')!;

    expect(bound(colonne), 'la colonne reste bornée').not.toBeNull();
    expect(colonne.contains(panneau), 'le panneau n’est pas dans la colonne').toBe(false);
    // Et il vient APRÈS elle : la rangée est « contenu à gauche, panneau à droite ».
    expect(
      colonne.compareDocumentPosition(panneau) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('la barre va d’un bord à l’autre, au-dessus de la rangée', async () => {
    await render(
      <PageShell
        title="A"
        fill
        toolbarBleed
        toolbar={<div data-testid="barre">barre</div>}
        aside={<aside data-testid="panneau">panneau</aside>}
      >
        <p data-testid="corps">corps</p>
      </PageShell>,
    );
    const barre = container.querySelector<HTMLElement>('[data-testid="barre"]')!;
    const colonne = holder('corps');

    // Hors de la colonne bornée, sinon elle ne va pas d'un bord à l'autre.
    expect(colonne.contains(barre)).toBe(false);
    expect(bound(colonne), 'la colonne reste bornée').not.toBeNull();
    // Et AVANT elle : en-tête, barre, puis la rangée.
    expect(barre.compareDocumentPosition(colonne) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('sans aside, rien de plus n’est rendu à côté du contenu', async () => {
    await render(
      <PageShell title="A" fill>
        <p data-testid="corps">corps</p>
      </PageShell>,
    );
    const rangee = holder('corps').parentElement!;
    expect(rangee.children).toHaveLength(1);
  });
});

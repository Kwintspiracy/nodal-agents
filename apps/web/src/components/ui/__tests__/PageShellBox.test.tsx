// PageShellBox.test.tsx — LA boîte de contenu, la même sur toutes les pages
// (Quentin, 20/09 : « toutes les pages de contenu font des tailles
// différentes, c'est un enfer »).
//
// Ce qui s'était passé : la zone de défilement de la disposition est devenue
// une colonne flex (pour Safari), et une boîte `mx-auto` qui est un ENFANT
// FLEX prend la largeur de son contenu, pas celle de sa colonne — les marges
// automatiques sur l'axe transversal l'emportent sur l'étirement. Chaque page
// faisait alors la largeur de ce qu'elle contenait : une table étroite ici,
// une grille qui déborde là. `w-full` rend la boîte à sa largeur : 100 % de la
// colonne, plafonnée à `max-w-6xl`, centrée.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PageShell from '../PageShell';

function boite(html: string): string {
  const i = html.indexOf('pb-10');
  const debut = html.lastIndexOf('class="', i);
  return html.slice(debut, html.indexOf('"', debut + 7));
}

describe('PageShell — une seule boîte de contenu @cap:installer-et-demarrer/ecran', () => {
  it('le corps d’une page ordinaire est PLEINE LARGEUR, borné et centré', () => {
    const html = renderToStaticMarkup(
      <PageShell title="Any page">
        <p>content</p>
      </PageShell>,
    );
    const classes = boite(html);
    expect(classes).toContain('w-full');
    expect(classes).toContain('mx-auto');
    expect(classes).toContain('max-w-6xl');
    // Les gouttières SUR la boîte, jamais à côté : c'est ce qui donne la même
    // largeur de contenu partout (1152 − 2 × 36 au-delà de `lg`).
    expect(classes).toContain('px-5');
    expect(classes).toContain('lg:px-9');
  });

  it('un écran `fill` borne sa colonne de la même façon', () => {
    const html = renderToStaticMarkup(
      <PageShell title="Fill page" fill>
        <p>content</p>
      </PageShell>,
    );
    expect(html).toContain('mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col');
  });

  it('`fluid` retire la borne, et rien d’autre', () => {
    const html = renderToStaticMarkup(
      <PageShell title="Fluid page" fluid>
        <p>content</p>
      </PageShell>,
    );
    const classes = boite(html);
    expect(classes).toContain('w-full');
    expect(classes).not.toContain('max-w-6xl');
  });
});

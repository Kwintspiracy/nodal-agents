// PageShellOrder.test.tsx — l'ORDRE d'une page de détail (#242) :
// l'en-tête, la barre, la rangée d'actions, puis le contenu.
//
// C'est la décision produit du 19/09, et elle ne se relit pas à l'œil à chaque
// PR : une action qui remonte d'une rangée retombe sur la ligne du retour, et
// c'est exactement le retour que Quentin a donné « page après page ».
//
// Le second fait prouvé ici est géométrique : une barre qui déborde sort de
// l'enveloppe à gouttières du corps. Sans cela ses deux filets seraient coupés
// de chaque côté, et elle ne tomberait pas où elle tombe sur les écrans de fil.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/agents/a-1/edit',
}));

import PageShell from '../PageShell';
import WorkBar from '../WorkBar';
import ActionRow from '../ActionRow';

function page(): string {
  return renderToStaticMarkup(
    <PageShell
      title="Edit agent"
      subtitle="Alfred"
      toolbarBleed
      toolbar={<WorkBar back={{ label: 'Back to agents', parent: '/agents' }} />}
    >
      <ActionRow>
        <button type="button">Run now</button>
      </ActionRow>
      <p data-testid="contenu">The body of the page.</p>
    </PageShell>,
  );
}

describe('PageShell — l’ordre d’une page de détail @cap:suivre-execution/ecran', () => {
  it('en-tête, puis barre, puis rangée d’actions, puis contenu', () => {
    const html = page();
    const iTitre = html.indexOf('Edit agent');
    const iBarre = html.indexOf('data-testid="work-bar"');
    const iActions = html.indexOf('data-testid="action-row"');
    const iContenu = html.indexOf('data-testid="contenu"');
    expect(iTitre).toBeGreaterThanOrEqual(0);
    expect(iBarre).toBeGreaterThan(iTitre);
    expect(iActions).toBeGreaterThan(iBarre);
    expect(iContenu).toBeGreaterThan(iActions);
  });

  it('« Run now » n’est PAS dans la barre : c’est la faute constatée le 19/09', () => {
    const html = page();
    const barre = html.slice(
      html.indexOf('data-testid="work-bar"'),
      html.indexOf('data-testid="action-row"'),
    );
    expect(barre).not.toContain('Run now');
  });

  it('une barre qui déborde est DEHORS de l’enveloppe à gouttières du corps', () => {
    const html = page();
    // L'enveloppe du corps porte `max-w-6xl` : la barre la précède.
    expect(html.indexOf('data-testid="work-bar"')).toBeLessThan(html.indexOf('max-w-6xl'));
  });

  it('la fente `aside` pose le panneau HORS de la colonne, sous la barre', () => {
    // #237 — un panneau ancré pousse la page au lieu de la couvrir. Posé dans
    // `children`, il vivrait DANS la colonne de contenu : borné par sa
    // largeur, et commençant sous la zone de barre d'outils au lieu du filet.
    const html = renderToStaticMarkup(
      <PageShell
        fill
        fluid
        title="A project"
        toolbarBleed
        toolbar={<WorkBar back={{ label: 'Workspaces', parent: '/spaces' }} />}
        aside={<aside data-testid="le-panneau">Files</aside>}
      >
        <p data-testid="contenu">The body of the page.</p>
      </PageShell>,
    );
    const iBarre = html.indexOf('data-testid="work-bar"');
    const iContenu = html.indexOf('data-testid="contenu"');
    const iPanneau = html.indexOf('data-testid="le-panneau"');
    expect(iBarre).toBeGreaterThan(-1);
    expect(iPanneau).toBeGreaterThan(iContenu);
    expect(iContenu).toBeGreaterThan(iBarre);
    // Le panneau n'est PAS dans la colonne de contenu : rien du corps ne le
    // contient. Sa balise ouvre après la fermeture de celle du contenu.
    const finContenu = html.indexOf('</p>', iContenu);
    expect(iPanneau).toBeGreaterThan(finContenu);
  });

  it('un écran pleine hauteur ORDINAIRE borne sa colonne ; `fluid` la libère', () => {
    const borne = renderToStaticMarkup(
      <PageShell fill title="Borné">
        <p>x</p>
      </PageShell>,
    );
    expect(borne).toContain('max-w-6xl');
    const libre = renderToStaticMarkup(
      <PageShell fill fluid title="Libre">
        <p>x</p>
      </PageShell>,
    );
    expect(libre).not.toContain('max-w-6xl');
  });

  it('sans le drapeau, le toolbar reste DANS les gouttières — une page de liste', () => {
    const html = renderToStaticMarkup(
      <PageShell title="Agents" toolbar={<span data-testid="filtres">Filters</span>}>
        <p>Rows.</p>
      </PageShell>,
    );
    expect(html.indexOf('max-w-6xl')).toBeLessThan(html.indexOf('data-testid="filtres"'));
  });
});

// WorkBar.test.tsx — la barre du design system : ce qu'elle porte, et ce
// qu'elle REFUSE de porter (#242).
//
// Le constat du 19/09 tenait en deux phrases. « Trop de pages n'utilisent pas
// cette barre, ce qui veut dire que ce n'est pas un système » — d'où la garde
// `src/tests/work-bar.arch.test.ts`, qui compte les pages. Et : les actions de
// la page étaient sur la ligne du retour — d'où ce fichier, qui prouve ce que
// la barre dessine, et dans quel ordre.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/scheduled/run-7',
}));

import WorkBar from '../WorkBar';
import ActionRow from '../ActionRow';

describe('WorkBar — la barre d’une page de détail @cap:suivre-execution/ecran', () => {
  it('porte le retour de la page, avec son libellé et son parent', () => {
    const html = renderToStaticMarkup(
      <WorkBar back={{ label: 'Back to Scheduled', parent: '/scheduled' }} />,
    );
    expect(html).toContain('Back to Scheduled');
    // Le `href` EST le parent : clic du milieu et nouvel onglet mènent là.
    expect(html).toContain('href="/scheduled"');
    expect(html).toContain('data-testid="work-bar"');
  });

  it('sans contexte, elle ne dessine que le retour — pas de bloc droit vide', () => {
    const html = renderToStaticMarkup(<WorkBar back={{ label: 'Back', parent: '/logs' }} />);
    expect(html).not.toContain('ml-auto');
  });

  it('le contexte de la page vient APRÈS le retour, à droite', () => {
    const html = renderToStaticMarkup(
      <WorkBar
        back={{ label: 'Back to Code', parent: '/code' }}
        context={<span data-testid="ctx">2 agents</span>}
      />,
    );
    expect(html.indexOf('Back to Code')).toBeLessThan(html.indexOf('data-testid="ctx"'));
    expect(html).toContain('ml-auto');
  });

  it('la rangée d’actions est un bloc SÉPARÉ : la barre ne la contient pas', () => {
    // C'est le second constat du 19/09. Une action dans la barre la mettrait
    // sur la ligne du retour, et ce test existe pour que ça se voie.
    const barre = renderToStaticMarkup(<WorkBar back={{ label: 'Back', parent: '/agents' }} />);
    expect(barre).not.toContain('data-testid="action-row"');
    const rangee = renderToStaticMarkup(
      <ActionRow>
        <button type="button">Run now</button>
      </ActionRow>,
    );
    expect(rangee).toContain('data-testid="action-row"');
    expect(rangee).toContain('Run now');
    expect(rangee).not.toContain('data-testid="work-bar"');
  });

  it('la rangée d’actions tient le bord DROIT, sous le contexte de la barre', () => {
    // Revue #243, passe 1. Collée à gauche, elle retomberait juste sous le
    // retour — à l'endroit qu'on vient précisément de lui retirer.
    const rangee = renderToStaticMarkup(
      <ActionRow>
        <button type="button">Run now</button>
      </ActionRow>,
    );
    expect(rangee).toContain('justify-end');
  });
});

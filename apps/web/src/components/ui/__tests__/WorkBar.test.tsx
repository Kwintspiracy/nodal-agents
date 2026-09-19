// WorkBar.test.tsx — la barre du design system après le retrait des retours
// (#242, 19/09/2026).
//
// Elle portait un retour à gauche et le contexte à droite. Quentin, le soir :
// « retire les boutons retour PARTOUT ». Il ne reste que le contexte — et la
// règle qui en découle : une barre qui n'a rien à dire ne se dessine pas,
// parce qu'un bandeau de 54 px entre deux filets autour de rien n'est pas un
// élément d'interface.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import WorkBar from '../WorkBar';
import ActionRow from '../ActionRow';

describe('WorkBar — la barre d’une page de détail @cap:suivre-execution/ecran', () => {
  it('porte le contexte de la page, et rien d’autre', () => {
    const html = renderToStaticMarkup(<WorkBar context={<span>2 agents</span>} />);
    expect(html).toContain('data-testid="work-bar"');
    expect(html).toContain('2 agents');
  });

  it('ne dessine AUCUN retour : ni libellé, ni chevron, ni lien', () => {
    const html = renderToStaticMarkup(<WorkBar context={<span>Running</span>} />);
    expect(html).not.toContain('Back');
    expect(html).not.toContain('‹');
    expect(html).not.toContain('←');
    expect(html).not.toContain('<a ');
  });

  it('sans contexte, elle ne se dessine pas du tout — pas de bandeau vide', () => {
    expect(renderToStaticMarkup(<WorkBar context={null} />)).toBe('');
    expect(renderToStaticMarkup(<WorkBar context={false} />)).toBe('');
  });

  it('garde sa géométrie : 54 px, un fond, deux filets, ses propres gouttières (#135)', () => {
    const html = renderToStaticMarkup(<WorkBar context={<span>Idle</span>} />);
    expect(html).toMatch(/class="[^"]*h-\[54px\][^"]*"/);
    expect(html).toMatch(/class="[^"]*border-y border-rule-2[^"]*"/);
    expect(html).toMatch(/class="[^"]*bg-canvas[^"]*"/);
    expect(html).toMatch(/class="[^"]*px-5[^"]*lg:px-9[^"]*"/);
  });

  it('la rangée d’actions est un bloc SÉPARÉ : la barre ne la contient pas', () => {
    const barre = renderToStaticMarkup(<WorkBar context={<span>Idle</span>} />);
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
    const rangee = renderToStaticMarkup(
      <ActionRow>
        <button type="button">Run now</button>
      </ActionRow>,
    );
    expect(rangee).toContain('justify-end');
  });
});

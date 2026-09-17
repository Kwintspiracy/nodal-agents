// AttentionCount.test.tsx — la pastille de ce qui attend la personne (#135).
//
// Ce qui se prouve : la BORNE exacte du plafond. « 9+ » commence à dix, pas à
// neuf — un seuil décalé d'un ferait lire « 9+ » à quelqu'un qui a exactement
// neuf choses à faire (revue Reviewer C, PR #145 : le seuil n'était testé
// qu'à 12 et 7).

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AttentionCount from '../AttentionCount.tsx';

function text(count: number, max?: number): string {
  const html = renderToStaticMarkup(
    max === undefined ? (
      <AttentionCount count={count} />
    ) : (
      <AttentionCount count={count} max={max} />
    ),
  );
  return html.replace(/<[^>]+>/g, '');
}

describe('AttentionCount — le plafond, à la borne près', () => {
  it('avec un plafond de neuf : neuf s’écrit « 9 », dix s’écrit « 9+ »', () => {
    expect(text(9, 9)).toBe('9');
    expect(text(10, 9)).toBe('9+');
    expect(text(1, 9)).toBe('1');
  });

  it('sans plafond donné : celui d’Approvals, quatre-vingt-dix-neuf', () => {
    expect(text(99)).toBe('99');
    expect(text(100)).toBe('99+');
  });

  it('la variante pleine porte le corail plein et le texte papier de la planche', () => {
    const html = renderToStaticMarkup(<AttentionCount count={3} max={9} variant="solid" />);
    expect(html).toContain('bg-err ');
    expect(html).toContain('text-paper');
    expect(html).toContain('text-micro-10');
    expect(html).toContain('rounded-full');
  });
});

// ProducedCard.test.tsx — l'encart de P7 rendu en HTML.
//
// Ce qui se prouve : l'encart NOMME ce qui est sorti, dit OÙ ça vit et y
// renvoie ; sans projet enregistré il le dit au lieu de laisser un blanc ; et
// un classement incertain paraît en toutes lettres, jamais arrondi.
//
// Rendu statique côté serveur (renderToStaticMarkup) : pas de navigateur, pas
// de bibliothèque de test de composants dans ce dépôt — on lit le HTML.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ProducedCard from '../ProducedCard.tsx';
import type { ProductionVerdict } from '@/lib/chat-or-work.ts';

const travail: ProductionVerdict = {
  isWork: true,
  items: [
    { kind: 'file', label: 'out/bilan.md', path: 'out/bilan.md' },
    { kind: 'command', label: 'pnpm build' },
  ],
  uncertain: 0,
  more: 0,
  unclassified: 0,
};

describe('ProducedCard', () => {
  it('nomme ce qui est sorti, son projet, et renvoie à sa page', () => {
    const html = renderToStaticMarkup(
      <ProducedCard
        verdict={travail}
        project={{ id: 'proj-42', name: 'Bilans', path: '/terrain/bilans' }}
      />,
    );
    expect(html).toContain('Produced');
    expect(html).toContain('out/bilan.md');
    expect(html).toContain('pnpm build');
    expect(html).toContain('Bilans');
    expect(html).toContain('/terrain/bilans');
    expect(html).toContain('href="/spaces/proj-42"');
  });

  it('sans projet enregistré, il le DIT et ne renvoie nulle part', () => {
    const html = renderToStaticMarkup(<ProducedCard verdict={travail} project={null} />);
    expect(html).toContain('outside any registered project');
    expect(html).not.toContain('href="/spaces/');
  });

  it('un classement incertain est écrit en toutes lettres', () => {
    const html = renderToStaticMarkup(
      <ProducedCard
        verdict={{
          isWork: true,
          items: [
            { kind: 'file', label: 'a.md', path: 'a.md' },
            { kind: 'external', label: 'mcp_inconnu__faire', certain: false },
          ],
          uncertain: 1,
          more: 0,
          unclassified: 0,
        }}
        project={null}
      />,
    );
    expect(html).toContain('1 classification uncertain: the tool declared no risk level');
    expect(html).toContain('mcp_inconnu__faire');
  });

  it('les fichiers au-delà du plafond sont comptés, pas oubliés', () => {
    const html = renderToStaticMarkup(
      <ProducedCard
        verdict={{ ...travail, more: 3 }}
        project={{ id: 'p', name: 'X', path: '/x' }}
      />,
    );
    expect(html).toContain('and 3 more files');
  });
});

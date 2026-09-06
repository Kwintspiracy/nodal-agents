// fragment-diff.test.ts — le diff d'un fragment (P11).
//
// Les assertions portent sur le SCRIPT rendu, ligne par ligne, jamais sur un
// compte : un diff qui présenterait deux textes différents comme identiques
// passerait n'importe quelle vérification de longueur.

import { describe, it, expect } from 'vitest';
import { fragmentDiff, FRAGMENT_DIFF_MAX_LINES } from '../fragment-diff';

const rendu = (a: string, b: string): string[] =>
  fragmentDiff(a, b).lines.map((l) => `${l.kind}${l.text}`);

describe('fragmentDiff', () => {
  it('deux textes identiques : que du contexte', () => {
    const res = fragmentDiff('un\ndeux', 'un\ndeux');
    expect(res.lines).toEqual([
      { kind: ' ', text: 'un' },
      { kind: ' ', text: 'deux' },
    ]);
    expect(res.truncated).toBe(false);
  });

  it('une insertion : la ligne neuve en +, le reste en contexte', () => {
    expect(rendu('un\ntrois', 'un\ndeux\ntrois')).toEqual([' un', '+deux', ' trois']);
  });

  it('une suppression : la ligne disparue en -', () => {
    expect(rendu('un\ndeux\ntrois', 'un\ntrois')).toEqual([' un', '-deux', ' trois']);
  });

  it('un remplacement : la ligne d avant en -, celle d après en +', () => {
    const res = rendu('un\ndeux\ntrois', 'un\nDEUX\ntrois');
    expect(res).toContain('-deux');
    expect(res).toContain('+DEUX');
    expect(res[0]).toBe(' un');
    expect(res[res.length - 1]).toBe(' trois');
  });

  it('un texte vide d un côté : tout est ajouté ou tout est retiré', () => {
    expect(rendu('', 'neuf')).toEqual(['+neuf']);
    expect(rendu('parti', '')).toEqual(['-parti']);
  });

  it('reconstruit exactement les deux textes', () => {
    // La seule propriété qui compte vraiment : ce que l écran montre DOIT se
    // relire comme l avant et l après. Un diff qui « a l air bon » mais perd
    // une ligne mentirait sans qu aucun test de forme ne le voie.
    const avant = 'alpha\nbeta\ngamma\ndelta';
    const apres = 'alpha\nBETA\ngamma\nepsilon\ndelta';
    const { lines } = fragmentDiff(avant, apres);
    expect(
      lines
        .filter((l) => l.kind !== '+')
        .map((l) => l.text)
        .join('\n'),
    ).toBe(avant);
    expect(
      lines
        .filter((l) => l.kind !== '-')
        .map((l) => l.text)
        .join('\n'),
    ).toBe(apres);
  });

  it('au-delà de la borne : un remplacement en bloc, ANNONCÉ', () => {
    const gros = Array.from({ length: FRAGMENT_DIFF_MAX_LINES + 1 }, (_, i) => `l${i}`).join('\n');
    const res = fragmentDiff(gros, 'court');
    expect(res.truncated).toBe(true);
    expect(res.lines.filter((l) => l.kind === ' ')).toEqual([]);
    expect(res.lines[res.lines.length - 1]).toEqual({ kind: '+', text: 'court' });
  });

  it('juste sous la borne, le diff reste fin', () => {
    const lignes = Array.from({ length: FRAGMENT_DIFF_MAX_LINES }, (_, i) => `l${i}`);
    const apres = [...lignes];
    apres[5] = 'CHANGÉE';
    const res = fragmentDiff(lignes.join('\n'), apres.join('\n'));
    expect(res.truncated).toBe(false);
    expect(res.lines.filter((l) => l.kind === '+')).toEqual([{ kind: '+', text: 'CHANGÉE' }]);
    expect(res.lines.filter((l) => l.kind === '-')).toEqual([{ kind: '-', text: 'l5' }]);
  });
});

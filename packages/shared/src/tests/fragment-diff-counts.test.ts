// fragment-diff-counts.test.ts — le compte du diff (issue #394).
//
// Les compteurs « +N −M » d'un fichier disaient le CHURN : les lignes du
// nouveau texte contre celles de l'ancien, pendant que la plaque dessinait un
// diff. Une édition qui remplaçait 59 lignes par 261 dont 250 identiques
// annonçait « +261 −59 » au-dessus d'une dizaine de rangées coloriées.
//
// Ce qui suit prouve que les deux ne peuvent plus diverger : le compte EST
// celui des lignes signées du script que `fragmentDiff` rend. Chaque cas est
// comparé au script lui-même, jamais à un nombre recopié à la main.

import { describe, it, expect } from 'vitest';
import { fragmentDiff, fragmentDiffCounts, FRAGMENT_DIFF_MAX_LINES } from '../fragment-diff';

const duScript = (a: string, b: string): { added: number; removed: number } => {
  const { lines } = fragmentDiff(a, b);
  return {
    added: lines.filter((l) => l.kind === '+').length,
    removed: lines.filter((l) => l.kind === '-').length,
  };
};

describe('fragmentDiffCounts @cap:verifier-un-livrable/moteur', () => {
  it('compte exactement les lignes signées du script, sur des formes différentes', () => {
    const cas: Array<[string, string]> = [
      ['', ''],
      ['', ['a', 'b', 'c'].join('\n')],
      [['a', 'b', 'c'].join('\n'), ''],
      [['un', 'deux'].join('\n'), ['un', 'deux'].join('\n')],
      [['un', 'deux', 'trois'].join('\n'), ['un', 'DEUX', 'trois'].join('\n')],
      [['a', 'b', 'c', 'd'].join('\n'), ['d', 'c', 'b', 'a'].join('\n')],
      [['tete', 'x', 'queue'].join('\n'), ['tete', 'y', 'z', 'queue'].join('\n')],
      [
        Array.from({ length: 60 }, (_, i) => `l${i}`).join('\n'),
        Array.from({ length: 60 }, (_, i) => (i === 30 ? 'AUTRE' : `l${i}`)).join('\n'),
      ],
    ];
    for (const [a, b] of cas) {
      expect({ a, b, ...fragmentDiffCounts(a, b) }).toEqual({ a, b, ...duScript(a, b) });
    }
  });

  it('le cas de l’issue : 59 lignes remplacées par 261 dont 250 communes', () => {
    const commun = Array.from({ length: 250 }, (_, i) => `<p>ligne ${i}</p>`);
    const avant = [...commun.slice(0, 50), ...Array.from({ length: 9 }, (_, i) => `<old ${i}>`)];
    const apres = [
      ...commun.slice(0, 50),
      ...Array.from({ length: 11 }, (_, i) => `<new ${i}>`),
      ...commun.slice(50),
    ];
    expect(avant).toHaveLength(59);
    expect(apres).toHaveLength(261);
    const a = avant.join('\n');
    const b = apres.join('\n');
    // Le churn disait « +261 −59 » ; le diff dit onze lignes touchées et deux
    // cents qui ne faisaient que se déplacer sous la borne des rangées.
    expect(fragmentDiffCounts(a, b)).toEqual({ added: 211, removed: 9 });
    expect(fragmentDiffCounts(a, b)).toEqual(duScript(a, b));
  });

  it('une écriture sans texte précédent compte TOUT son contenu comme ajouté', () => {
    const contenu = Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n');
    expect(fragmentDiffCounts('', contenu)).toEqual({ added: 12, removed: 0 });
    expect(fragmentDiffCounts('', contenu)).toEqual(duScript('', contenu));
  });

  it('au-delà de la borne, elle dit le remplacement en bloc que le script dessine', () => {
    const gros = Array.from({ length: FRAGMENT_DIFF_MAX_LINES + 1 }, (_, i) => `l${i}`).join('\n');
    const presque = Array.from({ length: FRAGMENT_DIFF_MAX_LINES + 1 }, (_, i) =>
      i === 7 ? 'AUTRE' : `l${i}`,
    ).join('\n');
    expect(fragmentDiffCounts(gros, presque)).toEqual({
      added: FRAGMENT_DIFF_MAX_LINES + 1,
      removed: FRAGMENT_DIFF_MAX_LINES + 1,
    });
    expect(fragmentDiffCounts(gros, presque)).toEqual(duScript(gros, presque));
  });
});

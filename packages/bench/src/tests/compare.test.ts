// compare.test.ts — le banc doit être plus fiable que ce qu'il mesure.
//
// Un comparateur qui se trompe rend toutes les mesures sans valeur, et le fait
// SILENCIEUSEMENT : il n'affiche jamais de régression, donc tout paraît sain.
// Ces cas sont donc écrits pour le prendre en défaut, pas pour le confirmer.

import { describe, it, expect } from 'vitest';
import { diffSection } from '../compare';
import type { Metric, SectionResult } from '../types';

const m = (over: Partial<Metric> & Pick<Metric, 'id' | 'value' | 'direction'>): Metric => ({
  label: over.id,
  unit: 'u',
  ...over,
});

const result = (metrics: Metric[], error?: string): SectionResult => ({
  sectionId: 's',
  metrics,
  durationMs: 1,
  ...(error ? { error } : {}),
});

describe('diffSection', () => {
  it('sans baseline, tout est « new » — jamais comparé à zéro', () => {
    // Le piège : traiter une baseline absente comme 0 ferait passer « 12
    // violations » pour une régression de +12 au premier run, et « 0 » pour un
    // succès. Les deux sont faux : la vérité est qu'on ne sait pas encore.
    const d = diffSection(
      'S',
      result([m({ id: 'a', value: 12, direction: 'lower-is-better' })]),
      null,
    );
    expect(d.diffs[0]!.verdict).toBe('new');
    expect(d.diffs[0]!.before).toBeNull();
    expect(d.regressed).toBe(false);
  });

  it('lower-is-better : une hausse régresse, une baisse améliore', () => {
    const base = [m({ id: 'a', value: 5, direction: 'lower-is-better' })];
    expect(
      diffSection('S', result([m({ id: 'a', value: 7, direction: 'lower-is-better' })]), base)
        .diffs[0]!.verdict,
    ).toBe('regressed');
    expect(
      diffSection('S', result([m({ id: 'a', value: 2, direction: 'lower-is-better' })]), base)
        .diffs[0]!.verdict,
    ).toBe('improved');
  });

  it('higher-is-better : une BAISSE régresse — le cas « package plus scanné »', () => {
    const base = [m({ id: 'packages', value: 29, direction: 'higher-is-better' })];
    const d = diffSection(
      'S',
      result([m({ id: 'packages', value: 28, direction: 'higher-is-better' })]),
      base,
    );
    expect(d.diffs[0]!.verdict).toBe('regressed');
    expect(d.regressed).toBe(true);
  });

  it('exact : tout mouvement régresse, dans les DEUX sens', () => {
    // La matrice du gate est `exact` pour cette raison : moins de demandes peut
    // vouloir dire qu'une action a perdu sa garde ; plus de demandes, qu'un
    // réglage d'autonomie n'est plus honoré. Les deux méritent un examen.
    const base = [m({ id: 'asks', value: 10, direction: 'exact' })];
    for (const v of [9, 11]) {
      expect(
        diffSection('S', result([m({ id: 'asks', value: v, direction: 'exact' })]), base).diffs[0]!
          .verdict,
      ).toBe('regressed');
    }
    expect(
      diffSection('S', result([m({ id: 'asks', value: 10, direction: 'exact' })]), base).diffs[0]!
        .verdict,
    ).toBe('unchanged');
  });

  it('une métrique DISPARUE est signalée, pas ignorée', () => {
    // Une section qui cesse de mesurer ressemble à une section dont le nombre
    // est tombé à zéro. Le second cas est le seul intéressant, donc on ne peut
    // pas confondre les deux.
    const d = diffSection('S', result([]), [
      m({ id: 'a', value: 3, direction: 'lower-is-better' }),
    ]);
    expect(d.diffs).toHaveLength(1);
    expect(d.diffs[0]!.verdict).toBe('gone');
  });

  it('une section en erreur compte comme régressée', () => {
    // Sinon une mesure cassée devient invisible : zéro métrique, zéro
    // régression, run vert.
    const d = diffSection('S', result([], 'réseau injoignable'), []);
    expect(d.regressed).toBe(true);
    expect(d.error).toBe('réseau injoignable');
  });

  it('reporte le detail sur le diff, pour rendre la régression actionnable', () => {
    const d = diffSection(
      'S',
      result([
        m({ id: 'a', value: 1, direction: 'lower-is-better', detail: ['packages/x/src/y.ts:12'] }),
      ]),
      [m({ id: 'a', value: 0, direction: 'lower-is-better' })],
    );
    expect(d.diffs[0]!.verdict).toBe('regressed');
    expect(d.diffs[0]!.detail).toEqual(['packages/x/src/y.ts:12']);
  });
});

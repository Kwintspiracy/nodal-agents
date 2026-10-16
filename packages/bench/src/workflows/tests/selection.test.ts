// selection.test.ts — quels scénarios une commande lance.
//
// Revue Reviewer A de #756, passe 2 (P2-1) : un scénario qui envoie au
// propriétaire (`sends: 'owner'`) ne fait partie d'aucun jeu, d'aucune
// activité, d'aucune matrice, ni du jeu de nuit. On le lance en le nommant
// (`--only`), et il ne part qu'avec `--allow-owner-sends` (runTrial).

import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../scenarios';
import { assertMatrixable, selectScenarios } from '../selection';

const ids = (xs: ReadonlyArray<{ id: string }>): string[] => xs.map((x) => x.id);

describe('selectScenarios', () => {
  it('no set, no activity ever holds a scenario that sends to the owner', () => {
    for (const sel of [
      {},
      { set: 'nightly' },
      { set: 'release' },
      { activity: ['image-comfyui'] },
    ]) {
      expect(ids(selectScenarios(sel))).not.toContain('comfyui-telegram');
    }
    expect(ids(selectScenarios({ activity: ['image-comfyui'] }))).toEqual([
      'comfy-square',
      'comfy-variants',
      'comfy-portrait',
      'comfy-landscape',
    ]);
  });

  it('naming it with --only selects it', () => {
    expect(ids(selectScenarios({ only: ['comfyui-telegram'] }))).toEqual(['comfyui-telegram']);
  });

  it('release is every scenario but the owner ones; nightly only the nightly ones', () => {
    expect(selectScenarios({ set: 'release' })).toHaveLength(SCENARIOS.length - 1);
    expect(selectScenarios({ set: 'nightly' }).every((s) => s.set === 'nightly')).toBe(true);
  });

  it('refuses an unknown scenario, set or activity', () => {
    expect(() => selectScenarios({ only: ['nope'] })).toThrow(/unknown scenario\(s\): nope/);
    expect(() => selectScenarios({ set: 'weekly' })).toThrow(/unknown set weekly/);
    expect(() => selectScenarios({ activity: ['cooking'] })).toThrow(/unknown activity: cooking/);
  });
});

describe('assertMatrixable', () => {
  it('a scenario that sends to the owner is never part of a model matrix', () => {
    expect(() =>
      assertMatrixable(selectScenarios({ only: ['question', 'comfyui-telegram'] })),
    ).toThrow(
      'workflow_owner_sends_in_matrix: comfyui-telegram sends to the owner and is never part of a model matrix',
    );
    expect(() => assertMatrixable(selectScenarios({ set: 'release' }))).not.toThrow();
  });
});

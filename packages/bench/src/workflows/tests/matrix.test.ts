// matrix.test.ts — la matrice des modèles : le plan, son coût, et le refus de jouer.
//
// Comment appliquer un modèle à un essai attend une décision du propriétaire.
// Ces cas prouvent que le plan est juste (prix du catalogue × médianes passées,
// un coût inconnu DIT, jamais zéro) et que le banc refuse de jouer une matrice
// AVANT de toucher la stack.

import { describe, expect, it } from 'vitest';
import { estimateCallCostUsd } from '@nodal-agents/shared';
import {
  formatPlan,
  OWN_MODELS,
  parseModels,
  planMatrix,
  planOwnModels,
  type PastLine,
} from '../matrix';
import { scenarioById } from '../scenarios';

const QUESTION = scenarioById('question')!;
const FILE = scenarioById('file')!;

function past(over: Partial<PastLine> & { scenario: string }): PastLine {
  return {
    // The scenario's current version: a line of an older version is not a median.
    scenarioVersion: scenarioById(over.scenario)!.version,
    durationMs: 20_000,
    inputTokens: 30_000,
    outputTokens: 100,
    verdict: 'green',
    ...over,
  };
}

describe('parseModels', () => {
  it('reads provider:model, and a bare model the catalog knows under one provider', () => {
    expect(parseModels('openrouter:z-ai/glm-5.3, deepseek-chat')).toEqual([
      { provider: 'openrouter', model: 'z-ai/glm-5.3' },
      { provider: 'deepseek', model: 'deepseek-chat' },
    ]);
  });

  it('refuses a model the catalog does not know, instead of guessing a provider', () => {
    expect(() => parseModels('nobody-knows-me')).toThrow(/workflow_unknown_model: nobody-knows-me/);
  });

  it('refuses a bare model two providers serve', () => {
    const catalog = { a: [{ modelId: 'm' }], b: [{ modelId: 'm' }] };
    expect(() => parseModels('m', catalog)).toThrow(
      'workflow_ambiguous_model: m is served by a, b',
    );
  });

  it('refuses the same model twice and an empty list', () => {
    expect(() => parseModels('deepseek:deepseek-chat,deepseek-chat')).toThrow(
      'workflow_model_twice: deepseek:deepseek-chat',
    );
    expect(() => parseModels(' , ')).toThrow('workflow_no_model');
  });
});

describe('planMatrix', () => {
  const glm = { provider: 'openrouter', model: 'z-ai/glm-5.3' };

  it('prices a cell from the catalog and the medians of past runs, times the trials', () => {
    const lines = [
      past({ scenario: 'question', inputTokens: 30_000, outputTokens: 100, cachedTokens: 20_000 }),
      past({ scenario: 'question', inputTokens: 40_000, outputTokens: 60, cachedTokens: 10_000 }),
      past({ scenario: 'question', inputTokens: 34_000, outputTokens: 80, cachedTokens: 12_000 }),
    ];
    const plan = planMatrix([QUESTION], [glm], 2, lines);
    const one = estimateCallCostUsd('openrouter', 'z-ai/glm-5.3', {
      inputTokens: 34_000,
      outputTokens: 80,
      cachedTokens: 12_000,
    });
    expect(plan.cells).toEqual([
      expect.objectContaining({
        scenario: 'question',
        activity: 'question',
        model: 'openrouter:z-ai/glm-5.3',
        trials: 2,
        pastRuns: 3,
        medianInputTokens: 34_000,
        estimatedUsd: Number((one * 2).toFixed(4)),
        why: null,
      }),
    ]);
    expect(one).toBeGreaterThan(0);
    expect(plan.unknownCells).toBe(0);
  });

  it('a scenario never run has NO estimate, said, never zero', () => {
    const plan = planMatrix([FILE], [glm], 1, [past({ scenario: 'question' })]);
    expect(plan.cells[0]).toMatchObject({
      estimatedUsd: null,
      why: 'no past run of this scenario version',
    });
    expect(plan.unknownCells).toBe(1);
  });

  it('a model without a catalog price has NO estimate, said, never zero', () => {
    const plan = planMatrix([QUESTION], [{ provider: 'ollama', model: 'llama-local' }], 1, [
      past({ scenario: 'question' }),
    ]);
    expect(plan.cells[0]).toMatchObject({
      estimatedUsd: null,
      why: 'no catalog price for ollama:llama-local',
    });
  });

  it('skipped runs, bench errors and older versions of the scenario are not medians', () => {
    const lines = [
      past({ scenario: 'question', inputTokens: 1_000_000, verdict: 'skipped' }),
      past({ scenario: 'question', inputTokens: 1_000_000, verdict: 'error' }),
      past({ scenario: 'question', inputTokens: 1_000_000, scenarioVersion: QUESTION.version - 1 }),
      past({ scenario: 'question', inputTokens: 30_000 }),
    ];
    const plan = planMatrix([QUESTION], [glm], 1, lines);
    expect(plan.cells[0]).toMatchObject({ pastRuns: 1, medianInputTokens: 30_000 });
  });

  it('prints one line per scenario × model, grouped by activity, with the total', () => {
    const plan = planMatrix(
      [QUESTION, FILE],
      [glm, { provider: 'deepseek', model: 'deepseek-chat' }],
      3,
      [past({ scenario: 'question' })],
    );
    const text = formatPlan(plan, [glm, { provider: 'deepseek', model: 'deepseek-chat' }]);
    expect(text).toContain('2 scenario(s) × 2 model(s) × 3 trial(s) = 12 trial(s)');
    expect(text).toContain('[question]');
    expect(text).toContain('[excel]');
    expect(text).toMatch(/file +openrouter:z-ai\/glm-5\.3 +×3 +cost unknown \(no past run/);
    expect(text).toContain('plus 2 cell(s) with no estimate');
  });
});

describe('planOwnModels', () => {
  it('estimates from what past runs really cost, times the trials, with their median time', () => {
    const lines = [
      past({ scenario: 'question', costUsd: 0.01, durationMs: 10_000 }),
      past({ scenario: 'question', costUsd: 0.03, durationMs: 30_000 }),
      past({ scenario: 'question', costUsd: 0.02, durationMs: 20_000 }),
      past({ scenario: 'question', costUsd: 9, verdict: 'skipped' }),
    ];
    const plan = planOwnModels([QUESTION], 3, lines);
    expect(plan.cells).toEqual([
      expect.objectContaining({
        scenario: 'question',
        model: OWN_MODELS,
        trials: 3,
        pastRuns: 3,
        medianDurationMs: 20_000,
        estimatedUsd: 0.06,
        why: null,
      }),
    ]);
    expect(plan).toMatchObject({ knownUsd: 0.06, unknownCells: 0, knownDurationMs: 60_000 });
  });

  it('a past run that did not report its cost, or no past run at all: NO estimate, said', () => {
    const plan = planOwnModels([QUESTION, FILE], 1, [
      past({ scenario: 'question', costUsd: 0.01 }),
      past({ scenario: 'question', costUsd: null }),
    ]);
    expect(plan.cells.map((c) => [c.scenario, c.estimatedUsd, c.why])).toEqual([
      ['question', null, 'a past run did not report its cost'],
      ['file', null, 'no past run of this scenario version'],
    ]);
    expect(plan.unknownCells).toBe(2);
  });
});

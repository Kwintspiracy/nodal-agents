// budget.test.ts — la campagne réserve le plafond de chaque essai sur ce qui reste, avant qu'il parte.

import { describe, expect, it } from 'vitest';
import type { TrialLine } from '../../workflows/types';
import { CampaignBudget } from '../budget';

const line = (costUsd: number | null): TrialLine =>
  ({ scenario: 's', rootJobId: 'j', costUsd, llmCalls: 1, cliRuns: 0 }) as unknown as TrialLine;

describe('the campaign budget: one reservation per trial, never more than what remains', () => {
  it('reserves min(trial cap, remaining), counts the real cost, and stops under one cent', () => {
    const b = new CampaignBudget(1, 2.5);
    expect(b.reserve()).toBe(1);
    expect(b.remaining).toBe(1.5);
    expect(b.record(line(0.9))).toBe('continue');
    expect(b.reserve()).toBe(1);
    expect(b.record(line(1))).toBe('continue');
    // 0,60 $ restent : l'essai suivant ne part qu'avec 0,60 $, jamais 1 $.
    expect(b.reserve()).toBe(0.6);
    expect(b.record(line(0.6))).toBe('stop');
    expect(b.stopped).toBe('the campaign spent $2.5 of its $2.5 cap');
    expect(b.reserve()).toBeNull();
  });

  it('refuses a second reservation before the first is counted: two trials never share the same remainder', () => {
    const b = new CampaignBudget(1, 10);
    b.reserve();
    expect(() => b.reserve()).toThrow(/campaign_budget_double_reservation/);
  });

  it('a trial that did not report its cost stops the campaign', () => {
    const b = new CampaignBudget(1, 10);
    b.reserve();
    expect(b.record(line(null))).toBe('stop');
    expect(b.stopped).toMatch(/did not report its cost/);
  });
});

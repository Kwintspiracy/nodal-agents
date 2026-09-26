/**
 * #504 — le rappel de progression INFORME, il n'arrête pas.
 *
 * Avant, il ordonnait « STOP gathering now… Do NOT call another gathering
 * tool » après 12 tours sans message, et un agent en pleine production (un
 * film : composition, rendu) l'a pris pour un arrêt et a rendu « blocked ».
 * Le texte est maintenant le même pour tous les agents et ne contient que des
 * faits : depuis combien de tours, et les limites réelles du run.
 */
import { describe, it, expect } from 'vitest';
import {
  progressReminder,
  budgetStopLine,
  budgetErrorCode,
  type ProgressFacts,
} from '../../job/execute.js';

const base: ProgressFacts = {
  turnsSinceDelivery: 12,
  turn: 13,
  maxTurns: 50,
  costSpentUsd: 0.4,
  costCeilingUsd: 2,
  workedMs: 25 * 60_000,
  timeCeilingMs: 2 * 3_600_000,
  tokensSpent: 180_000,
  tokenCeiling: 1_500_000,
};

describe('progressReminder', () => {
  it('dit les faits et les vraies limites du run, sans ordre', () => {
    expect(progressReminder(base)).toBe(
      '[system] Progress note: 12 turns since you last sent a result. ' +
        'This is information, not a stop. If you already have what was asked, deliver it now ' +
        'and call return_result. If the work still needs more steps, continue. ' +
        'Limits of this run: turn 50 (this is turn 13); run budget $2.00 ($0.40 spent); ' +
        '120 min of work (25 min so far); 1,500,000 tokens (180,000 used).',
    );
  });

  it('une limite que l’espace n’a pas posée n’est pas inventée', () => {
    // Pas de plafond de coût (0 dans Settings) ni de durée maximale : seules
    // les limites qui existent sont nommées.
    const texte = progressReminder({ ...base, costCeilingUsd: Infinity, timeCeilingMs: Infinity });
    expect(texte).toContain('Limits of this run: turn 50 (this is turn 13); 1,500,000 tokens');
    expect(texte).not.toContain('run budget');
    expect(texte).not.toContain('min of work');
  });

  it('ne nomme aucun outil que l’agent pourrait ne pas avoir, et n’ordonne rien', () => {
    // Invariant 9 : un agent n'a que les outils de sa liste. `return_result`
    // est le seul que tous ont ; l'ancien texte citait `dashboard_publish`.
    const texte = progressReminder(base);
    expect(texte).not.toMatch(/dashboard_publish|telegram_send_message/);
    expect(texte).not.toMatch(/\bSTOP\b|Do NOT|must stop/);
  });
});

describe('the turn cap is a run limit like the others (#504)', () => {
  it('its stop line names the limit, and its error code stays turn_limit_exceeded', () => {
    expect(budgetStopLine({ kind: 'turns', spent: 50, limit: 50, turn: 51 })).toBe(
      '[stopped: turn limit — 50 turns, ceiling 50]',
    );
    expect(budgetErrorCode('turns')).toBe('turn_limit_exceeded');
  });
});

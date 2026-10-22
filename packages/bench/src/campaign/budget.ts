// campaign/budget.ts — 1 $ au plus par essai, 10 $ par campagne, arrêt net au plafond.
//
// UNE borne par essai, tenue par le RUNNER : le budget de run de l'espace testé
// (`max_run_cost_usd`, Settings → Run budget). Depuis la revue de #836 (P1),
// il couvre tout l'arbre de délégation de l'essai, et chaque job de l'arbre le
// relit AVANT chaque appel au modèle et avant un tour de CLI
// (apps/runner/src/job/run-budget.ts). Le banc ne surveille plus rien lui-même.
//
// Avant chaque essai, la campagne RÉSERVE son plafond : min(plafond d'un
// essai, ce qui reste à la campagne), posé comme budget de run de l'espace. Un
// essai ne part donc jamais avec un plafond plus grand que ce qui reste. Après,
// elle compte ce que l'essai a réellement coûté, et libère la réservation.
//
// LA BORNE, dite : le runner arrête un job dès que la dépense de son arbre
// dépasse le plafond, en relisant l'arbre avant chaque appel. Au pire, chaque
// job vivant de l'arbre a UN appel en vol au moment où le plafond est franchi.
// Un essai coûte donc au plus son plafond plus un appel par job vivant de son
// arbre, et la campagne au plus 10 $ plus ce même dépassement de son DERNIER
// essai (les suivants ne partent pas). Sous un centime restant, plus aucun
// essai ne part : un budget de run à 0 voudrait dire « sans plafond » pour le
// runner, jamais un arrêt.
//
// Une dépense que l'essai n'a pas rapportée (un appel facturé sans prix)
// arrête la campagne : le plafond ne se tient plus, et le banc ne le devine
// pas (invariant #4).

import type { TrialLine } from '../workflows/types';

/** En dessous, la campagne ne lance plus d'essai. */
export const MIN_TRIAL_BUDGET_USD = 0.01;

export class CampaignBudget {
  private spentUsd = 0;
  private reservedUsd: number | null = null;
  private stopReason: string | null = null;

  constructor(
    readonly perTrialUsd: number,
    readonly perCampaignUsd: number,
  ) {}

  get spent(): number {
    return Number(this.spentUsd.toFixed(4));
  }

  get stopped(): string | null {
    return this.stopReason;
  }

  /** Ce qui reste à la campagne, réservation en cours déduite. */
  get remaining(): number {
    return this.perCampaignUsd - this.spentUsd - (this.reservedUsd ?? 0);
  }

  /**
   * Réserve le plafond de l'essai qui va partir : min(plafond d'un essai, ce
   * qui reste). null quand la campagne n'en lance plus. Une seconde
   * réservation avant que la première soit comptée est une erreur : deux
   * essais ne partagent jamais le même reste.
   */
  reserve(): number | null {
    if (this.reservedUsd !== null) {
      throw new Error('campaign_budget_double_reservation: a trial is already reserved');
    }
    if (this.stopReason !== null) return null;
    const remaining = this.remaining;
    if (remaining < MIN_TRIAL_BUDGET_USD) {
      this.stopReason = `the campaign spent $${this.spent} of its $${this.perCampaignUsd} cap`;
      return null;
    }
    const cap = Number(Math.min(this.perTrialUsd, remaining).toFixed(4));
    this.reservedUsd = cap;
    return cap;
  }

  /** Compte la dépense réelle de l'essai réservé ; rend `stop` quand la campagne doit s'arrêter. */
  record(line: TrialLine): 'continue' | 'stop' {
    this.reservedUsd = null;
    const billed = line.llmCalls > 0 || line.cliRuns > 0;
    if (line.costUsd === null && billed) {
      this.stopReason =
        `trial ${line.scenario} (${line.rootJobId ?? 'no job'}) did not report its cost: ` +
        'the campaign cap can no longer be kept';
      return 'stop';
    }
    this.spentUsd += line.costUsd ?? 0;
    if (this.remaining < MIN_TRIAL_BUDGET_USD) {
      this.stopReason = `the campaign spent $${this.spent} of its $${this.perCampaignUsd} cap`;
      return 'stop';
    }
    return 'continue';
  }
}

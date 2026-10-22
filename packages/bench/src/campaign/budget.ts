// campaign/budget.ts — 1 $ au plus par essai, 10 $ par campagne, arrêt net au plafond.
//
// Deux bornes, et chacune par le mécanisme qui existe :
//   - le budget de run de l'ESPACE testé (`max_run_cost_usd`, Settings → Run
//     budget) : le runner arrête un job qui le dépasse, avec ce qu'il a écrit ;
//     le banc le pose avant chaque essai (`setRunBudgetRepo`) ;
//   - le plafond de l'ARBRE de l'essai (`maxTreeCostUsd`, trial.ts) : un job
//     délégué a son propre budget de run, l'arbre entier peut donc dépasser
//     celui d'un job ; le banc l'annule quand la somme dépasse.
// Les deux valent min(plafond d'un essai, ce qui reste à la campagne). Sous un
// centime restant, plus aucun essai ne part : un budget de run à 0 voudrait
// dire « sans plafond » pour le runner, jamais un arrêt.
//
// Une dépense que l'essai n'a pas rapportée (un appel facturé sans prix)
// arrête la campagne : le plafond ne se tient plus, et le banc ne le devine
// pas (invariant #4).

import type { TrialLine } from '../workflows/types';

/** En dessous, la campagne ne lance plus d'essai. */
export const MIN_TRIAL_BUDGET_USD = 0.01;

export class CampaignBudget {
  private spentUsd = 0;
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

  /** Le plafond de l'essai qui va partir ; null quand la campagne n'en lance plus. */
  nextTrialCap(): number | null {
    if (this.stopReason !== null) return null;
    const remaining = this.perCampaignUsd - this.spentUsd;
    if (remaining < MIN_TRIAL_BUDGET_USD) {
      this.stopReason = `the campaign spent $${this.spent} of its $${this.perCampaignUsd} cap`;
      return null;
    }
    return Number(Math.min(this.perTrialUsd, remaining).toFixed(4));
  }

  /** Compte la dépense d'un essai ; rend `stop` quand la campagne doit s'arrêter. */
  record(line: TrialLine): 'continue' | 'stop' {
    const billed = line.llmCalls > 0 || line.cliRuns > 0;
    if (line.costUsd === null && billed) {
      this.stopReason =
        `trial ${line.scenario} (${line.rootJobId ?? 'no job'}) did not report its cost: ` +
        'the campaign cap can no longer be kept';
      return 'stop';
    }
    this.spentUsd += line.costUsd ?? 0;
    return this.nextTrialCap() === null ? 'stop' : 'continue';
  }
}

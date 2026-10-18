// workflows/selection.ts — quels scénarios une commande lance.
//
// Un scénario qui envoie au propriétaire (`sends: 'owner'`) ne fait partie
// d'AUCUN jeu, d'aucune activité, d'aucune matrice, ni du jeu de nuit : on le
// lance en le nommant (`--only`), et runTrial le saute encore sans
// `--allow-owner-sends` (revue Reviewer A de #756).

import { SCENARIOS, scenarioById } from './scenarios';
import { ACTIVITIES, type AnyScenario } from './types';

export interface Selection {
  readonly only?: readonly string[];
  readonly set?: string;
  readonly activity?: readonly string[];
}

const sendsToOwner = (s: AnyScenario): boolean => s.sends === 'owner';

export function selectScenarios(sel: Selection): AnyScenario[] {
  if (sel.only) {
    const unknown = sel.only.filter((id) => !scenarioById(id));
    if (unknown.length > 0) {
      throw new Error(
        `unknown scenario(s): ${unknown.join(', ')} — known: ${SCENARIOS.map((s) => s.id).join(', ')}`,
      );
    }
    return sel.only.map((id) => scenarioById(id)!);
  }
  const pool = SCENARIOS.filter((s) => !sendsToOwner(s));
  if (sel.activity) {
    // Nommer une activité, c'est demander ses scénarios, `on-demand` compris.
    const unknown = sel.activity.filter((a) => !(ACTIVITIES as readonly string[]).includes(a));
    if (unknown.length > 0)
      throw new Error(`unknown activity: ${unknown.join(', ')} — known: ${ACTIVITIES.join(', ')}`);
    return pool.filter((s) => sel.activity!.includes(s.activity));
  }
  const set = sel.set ?? 'nightly';
  if (set === 'release') return pool;
  if (set === 'nightly') return pool.filter((s) => s.set === 'nightly');
  throw new Error(`unknown set ${set} — known: nightly, release`);
}

/** Une matrice de modèles ne joue jamais un scénario qui envoie au propriétaire. */
export function assertMatrixable(scenarios: readonly AnyScenario[]): void {
  const owner = scenarios.filter(sendsToOwner).map((s) => s.id);
  if (owner.length > 0) {
    throw new Error(
      `workflow_owner_sends_in_matrix: ${owner.join(', ')} sends to the owner and is never part of a model matrix`,
    );
  }
}

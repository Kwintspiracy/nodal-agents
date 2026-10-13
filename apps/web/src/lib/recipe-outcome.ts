// recipe-outcome.ts — what the person is told after an agent is created from
// a profile.
//
// Every part of the outcome is said, each on its own: a skill the profile
// could not attach does not silence a connector it could not attach, nor the
// connectors left to set up (#661, review pass 2 of #663). The form only maps
// these to toasts.

import type { ApplyAgentRecipeResult } from './actions.ts';

export interface RecipeOutcomeMessage {
  kind: 'success' | 'error' | 'warning' | 'info';
  text: string;
}

export function recipeOutcomeMessages(applied: ApplyAgentRecipeResult): RecipeOutcomeMessage[] {
  const out: RecipeOutcomeMessage[] = [];
  if (applied.skillsMissing.length > 0) {
    // Fail loud, not silent: an agent missing what its profile promised is
    // quietly worse than the one asked for.
    out.push({
      kind: 'error',
      text: `Agent created, but ${applied.skillsMissing.length} skill(s) could not be attached: ${applied.skillsMissing.join(', ')}`,
    });
  } else {
    const parts = [`${applied.skillsAttached.length} skill(s) attached`];
    if (applied.connectorsAttached.length > 0) {
      parts.push(`${applied.connectorsAttached.length} connector(s) attached`);
    }
    if (applied.readOnlyApplied) parts.push('read-only');
    out.push({ kind: 'success', text: `Agent created — ${parts.join(', ')}` });
  }
  for (const missed of applied.connectorsNotAttached) {
    // Present in the workspace, not attached: the reason says why.
    out.push({ kind: 'warning', text: `${missed.slug} not attached: ${missed.reason}` });
  }
  if (applied.connectorsToSetUp.length > 0) {
    // A recommendation, not a failure: the panel said this was the user's
    // move. Repeated here so it is not forgotten.
    out.push({
      kind: 'info',
      text: `Still to set up from Connectors: ${applied.connectorsToSetUp.join(', ')} — then attach it to this agent.`,
    });
  }
  return out;
}

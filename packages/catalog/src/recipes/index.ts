// catalog/recipes/index.ts — the recipes that ship with the product.
//
// A recipe describes ONE agent, equipped for something; a team is a NAME and a
// SHAPE grouping several of them. Neither creates anything: they pre-fill the
// creation form the user then submits, and what comes out is an ordinary agent
// with no trace of the recipe in the database.
//
// Adding a recipe = a new entry below. Its `skills` must reference slugs that
// actually ship (asserted by the tests), because a recipe that attaches a
// missing skill produces an agent quietly worse than the one the user asked
// for.

import type { AgentRecipe, AgentTeam } from './types';
import { devTeam, devTeamRecipes } from './dev-team';

export type { AgentRecipe, AgentTeam, RecipeRole, RecipeNeed, ModelRequirement } from './types';
export {
  devTeam,
  devTeamRecipes,
  developerRecipe,
  codeReviewerRecipe,
  teamLeadRecipe,
} from './dev-team';

/** Every recipe that ships, flat. */
export const agentRecipes: AgentRecipe[] = [...devTeamRecipes];

/**
 * Teams, in the order they are offered.
 *
 * Order is a product statement: the first one reads as the default shape. Dev
 * team is first because it is the one the product can already support end to
 * end.
 */
export const agentTeams: AgentTeam[] = [devTeam];

/** Look up one recipe. Returns undefined for an unknown slug — callers decide. */
export function findAgentRecipe(slug: string): AgentRecipe | undefined {
  return agentRecipes.find((r) => r.slug === slug);
}

/**
 * The recipes of a team, in the team's own order, skipping any slug that does
 * not resolve. Tolerant on purpose: a typo in a team must not blank the whole
 * catalogue screen, and the tests catch it before it ships.
 */
export function recipesOfTeam(team: AgentTeam): AgentRecipe[] {
  return team.recipes
    .map((slug) => findAgentRecipe(slug))
    .filter((r): r is AgentRecipe => r !== undefined);
}

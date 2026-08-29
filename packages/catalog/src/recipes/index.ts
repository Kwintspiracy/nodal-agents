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
import type { SystemSkill } from '../types';
import { devTeam, devTeamRecipes } from './dev-team';

export type {
  AgentRecipe,
  AgentTeam,
  RecipeRole,
  RecipeNeed,
  RecipePreset,
  ModelRequirement,
} from './types';
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
/**
 * What a screen needs to SAY about a skill a recipe attaches — without the
 * skill's Markdown body. `systemSkills` carries every skill's full `content`;
 * importing it from a Client Component ships the whole catalog to the browser
 * on every /agents load (codex, #45). Computed on the server, passed as props.
 */
export interface RecipeSkillMeta {
  slug: string;
  name: string;
  description: string;
  requiredBuiltins: string[];
}

export function recipeSkillMeta(skills: SystemSkill[]): Record<string, RecipeSkillMeta> {
  const wanted = new Set(agentRecipes.flatMap((r) => r.skills));
  const out: Record<string, RecipeSkillMeta> = {};
  for (const s of skills) {
    if (!wanted.has(s.slug)) continue;
    out[s.slug] = {
      slug: s.slug,
      name: s.name,
      description: s.description,
      requiredBuiltins: s.requiredBuiltins ?? [],
    };
  }
  return out;
}

export function recipesOfTeam(team: AgentTeam): AgentRecipe[] {
  return team.recipes
    .map((slug) => findAgentRecipe(slug))
    .filter((r): r is AgentRecipe => r !== undefined);
}

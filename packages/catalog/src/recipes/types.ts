// catalog/recipes/types.ts — the shape of an agent recipe.
//
// A recipe describes ONE agent, equipped for something. It is data, not an
// agent: nothing exists until someone clicks, and what the click produces is
// an ordinary agent — same edit screen, same delete, no trace of the recipe in
// the database. Invariant #1 (no hardcoded agent metadata) holds because the
// runtime still reads everything from the DB; the recipe only pre-fills the
// creation form the user is about to submit.
//
// Deliberately NOT a team: the first draft of this feature created three
// agents in one click, which handed people a structure they had not chosen and
// three objects to understand before using one. Teams exist here only as a
// GROUPING of recipes (see `AgentTeam`) — a name and a shape that teach what
// tends to work, with no button that builds it for you.

/** UX-level role, matching the create form's own enum. */
export type RecipeRole = 'worker' | 'router' | 'planner';

/**
 * A capability the recipe needs from the model it runs on.
 * The form uses these to narrow the model list rather than let someone pick a
 * model that cannot do the job — an orchestrator on a model without tool
 * calling looks broken for reasons nobody can see.
 */
export type ModelRequirement = 'tools';

/**
 * Something the agent needs that is NOT a form field the recipe can fill in
 * for you. The form surfaces these so the gap is visible BEFORE creation
 * rather than discovered when the agent misbehaves.
 *
 * - `workspace`: a folder of its own. An agent that writes code without one
 *   writes into the shared hand-off area instead — the 27/08 incident. Shipped
 *   as a requirement in a later brique, once the create form carries the field.
 * - `code-runtime`: a way to actually run code — an installed CLI running under
 *   the machine's own session, or a model called with an API key.
 */
export type RecipeNeed = 'workspace' | 'code-runtime';

export interface AgentRecipe {
  /** Stable identifier. Never stored on the agent — used by the UI only. */
  slug: string;
  /** Name pre-filled into the form. The user can change it before creating. */
  name: string;
  /** One line, in the words of someone deciding what they need. */
  summary: string;
  /** UX role the form opens on. */
  role: RecipeRole;
  /** System skills attached right after creation, by slug. */
  skills: string[];
  /** What the model must be able to do for this agent to work at all. */
  modelRequirements?: ModelRequirement[];
  /** What the agent still needs, that the recipe cannot supply itself. */
  needs?: RecipeNeed[];
  /**
   * Short labels shown on the recipe card — the equipment, in the reader's
   * words. Not derived from the fields above on purpose: "lecture seule" says
   * something a list of skill slugs does not.
   */
  kit: string[];
}

export interface AgentTeam {
  /** Stable identifier. */
  slug: string;
  /** The team's name — this is what suggests a structure. */
  name: string;
  /**
   * How the roles relate, in one line. Purely explanatory: it teaches the shape
   * without creating it.
   */
  shape: string;
  /** Why this shape works — the knowledge nobody has on arrival. */
  rationale: string;
  /** Recipe slugs, in the order they are shown. */
  recipes: string[];
}

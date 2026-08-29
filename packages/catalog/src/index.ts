// @nodal-agents/catalog index.ts — aggregates the system catalog shipped with NodalAI.
//
// Source of truth: every system skill that every install of the same npm
// version should receive. The bootstrap skill seeder imports `systemSkills`
// and upserts each entry into the local DB at boot, respecting per-install
// user overrides.
//
// Scope: skills, and RECIPES for creating agents. Agents themselves are NOT
// shipped — every agent is created by the user, and a recipe only pre-fills the
// form they submit (see recipes/types.ts). Connectors ship via their own
// catalog (apps/web connector-catalog).
//
// Adding a new system skill = a new file in skills/ + an entry below.
// No SQL on live DBs.

import type { SystemSkill, SkillKind } from './types';

import { obsidianSkill } from './skills/obsidian';
import { researchScopeDisciplineSkill } from './skills/research-scope-discipline';
import { resultsDeliverySkill } from './skills/results-delivery';
import { telegramResponderSkill } from './skills/telegram-responder';
import { claudeHtmlDesignSkill } from './skills/claude-html-design';
import { languageMirrorSkill } from './skills/language-mirror';
import { markdownOutputSkill } from './skills/markdown-output';
import { taskPlanningSkill } from './skills/task-planning';
import { verifyBeforeDoneSkill } from './skills/verify-before-done';
import { citationDisciplineSkill } from './skills/citation-discipline';
import { safeToolUseSkill } from './skills/safe-tool-use';
import { workspaceHygieneSkill } from './skills/workspace-hygiene';
import { officeEditingSkill } from './skills/office-editing';
import { spreadsheetEditingSkill } from './skills/spreadsheet-editing';
import { documentEditingSkill } from './skills/document-editing';
import { presentationEditingSkill } from './skills/presentation-editing';
import { commandExecutionSkill } from './skills/command-execution';
import { codeTaskSkill } from './skills/code-task';
import { devSkill } from './skills/dev';
import { codeReviewSkill } from './skills/code-review';
import { requestReviewSkill } from './skills/request-review';
import { toolCreateMcpSkill } from './skills/tool-create-mcp';
import { toolCreateAgentSkill } from './skills/tool-create-agent';
import { toolUpdateAgentSkill } from './skills/tool-update-agent';
import { toolAttachMcpSkill } from './skills/tool-attach-mcp';
import { toolAttachConnectorSkill } from './skills/tool-attach-connector';
import { toolSchedulesSkill } from './skills/tool-schedules';

export { officeEditingSkill } from './skills/office-editing';
export { spreadsheetEditingSkill } from './skills/spreadsheet-editing';
export { documentEditingSkill } from './skills/document-editing';
export { presentationEditingSkill } from './skills/presentation-editing';
export { commandExecutionSkill } from './skills/command-execution';
export { codeTaskSkill } from './skills/code-task';
export { devSkill } from './skills/dev';
export { codeReviewSkill } from './skills/code-review';
export { requestReviewSkill } from './skills/request-review';

export const systemSkills: SystemSkill[] = [
  obsidianSkill,
  researchScopeDisciplineSkill,
  resultsDeliverySkill,
  telegramResponderSkill,
  claudeHtmlDesignSkill,
  languageMirrorSkill,
  markdownOutputSkill,
  taskPlanningSkill,
  verifyBeforeDoneSkill,
  citationDisciplineSkill,
  safeToolUseSkill,
  workspaceHygieneSkill,
  officeEditingSkill,
  spreadsheetEditingSkill,
  documentEditingSkill,
  presentationEditingSkill,
  commandExecutionSkill,
  codeTaskSkill,
  devSkill,
  codeReviewSkill,
  requestReviewSkill,
  // Tool usage guides — loaded on demand via skill_view, not auto-injected.
  toolCreateMcpSkill,
  toolCreateAgentSkill,
  toolUpdateAgentSkill,
  toolAttachMcpSkill,
  toolAttachConnectorSkill,
  toolSchedulesSkill,
];

/**
 * Canonical slugs of the system catalog. System skills are seeded under the
 * oldest entity but are install-wide: dashboard queries use this list to make
 * them visible/assignable from any entity (e.g. a LAN-mode signup whose entity
 * differs from the seed owner), without entity-scoping them away.
 */
export const systemSkillSlugs: string[] = systemSkills.map((s) => s.slug);

/** Effective kind of a skill (defaults to 'capability' when unset). */
export function skillKind(s: SystemSkill): SkillKind {
  return s.kind ?? 'capability';
}
/** Kind of a system skill by slug; null when the slug is not a system skill. */
export function skillKindOfSlug(slug: string): SkillKind | null {
  const s = systemSkills.find((x) => x.slug === slug);
  return s ? skillKind(s) : null;
}
const slugsOfKind = (k: SkillKind): string[] =>
  systemSkills.filter((s) => skillKind(s) === k).map((s) => s.slug);

/**
 * BASELINE skills — intrinsic discipline injected into EVERY agent's base prompt
 * (verify-before-done, safe-tool-use, language-mirror). Not assignable.
 */
export const baselineSkillSlugs: string[] = slugsOfKind('baseline');

/**
 * CHANNEL skills — injected automatically when the agent is bound to a channel
 * (telegram etiquette, markdown). Not assignable.
 */
export const channelSkillSlugs: string[] = slugsOfKind('channel');

/**
 * CAPABILITY skills — opt-in, shown in the dashboard library AND advertised to
 * the agent as discoverable (it knows they exist even when unassigned).
 */
export const capabilitySkillSlugs: string[] = slugsOfKind('capability');

/**
 * Agent-internal skills (loaded on demand via skill_view, e.g. the per-meta-tool
 * usage guides). Hidden from the library; still seeded and documented.
 */
export const agentInternalSkillSlugs: string[] = slugsOfKind('agent-internal');

/**
 * TOOL GROUP skills — presented as toggles on the agent's Tools tab and hidden
 * from every Skills surface, because their value IS the tools they unlock.
 *
 * Derived from the `toolGroup` flag each skill DECLARES, never deduced from
 * "does it gate a builtin" — that older rule filed discipline-carrying skills
 * (code-review, command-execution) under Tools, where the owner could not find
 * or edit their text. See the `toolGroup` doc in types.ts.
 */
export const toolGroupSkillSlugs: string[] = systemSkills
  .filter((s) => s.toolGroup === true)
  .map((s) => s.slug);

// `devTeamSkillSlugs` a existé ici du 25 au 26/08 : les skills `dev` et
// `code-review` désignaient alors les agents dont le travail entrait dans
// l'onglet Code. Retiré — cette identité ne marchait que si l'utilisateur
// employait NOS skills, jamais les siens ni ceux du catalogue communautaire.
// Ce qui est du développement se coche désormais sur le DOSSIER
// (`agent_workspaces.is_dev_folder`, migration 0085), et les deux skills
// redeviennent ce qu'ils auraient dû rester : de la guidance.

// ─── Recipes ──────────────────────────────────────────────────────────────
//
// A recipe describes ONE agent, equipped for something; a team is a name and a
// shape grouping several of them. Neither ships an agent: they pre-fill the
// creation form, and what the user submits produces an ordinary agent with no
// trace of the recipe in the database. The scope note at the top of this file
// still holds — agents are never shipped.
export {
  agentRecipes,
  agentTeams,
  findAgentRecipe,
  recipesOfTeam,
  recipeSkillMeta,
  devTeam,
  devTeamRecipes,
  developerRecipe,
  codeReviewerRecipe,
  teamLeadRecipe,
} from './recipes/index';
export type {
  AgentRecipe,
  AgentTeam,
  RecipeRole,
  RecipeNeed,
  RecipePreset,
  ModelRequirement,
  RecipeSkillMeta,
} from './recipes/index';

export type { SystemSkill, SkillKind };

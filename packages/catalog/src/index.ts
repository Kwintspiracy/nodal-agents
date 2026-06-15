// @nodal-agents/catalog index.ts — aggregates the system catalog shipped with NodalAI.
//
// Source of truth: every system skill that every install of the same npm
// version should receive. The bootstrap skill seeder imports `systemSkills`
// and upserts each entry into the local DB at boot, respecting per-install
// user overrides.
//
// Scope: skills only. Agents are NOT shipped — every agent is created by the
// user. Connectors ship via their own catalog (apps/web connector-catalog).
//
// Adding a new system skill = a new file in skills/ + an entry below.
// No SQL on live DBs.

import type { SystemSkill } from './types';

import { obsidianSkill } from './skills/obsidian';
import { researchScopeDisciplineSkill } from './skills/research-scope-discipline';
import { telegramResponderSkill } from './skills/telegram-responder';
import { claudeHtmlDesignSkill } from './skills/claude-html-design';
import { languageMirrorSkill } from './skills/language-mirror';
import { markdownOutputSkill } from './skills/markdown-output';
import { taskPlanningSkill } from './skills/task-planning';
import { verifyBeforeDoneSkill } from './skills/verify-before-done';
import { citationDisciplineSkill } from './skills/citation-discipline';
import { safeToolUseSkill } from './skills/safe-tool-use';
import { officeEditingSkill } from './skills/office-editing';
import { commandExecutionSkill } from './skills/command-execution';

export { officeEditingSkill } from './skills/office-editing';
export { commandExecutionSkill } from './skills/command-execution';

export const systemSkills: SystemSkill[] = [
  obsidianSkill,
  researchScopeDisciplineSkill,
  telegramResponderSkill,
  claudeHtmlDesignSkill,
  languageMirrorSkill,
  markdownOutputSkill,
  taskPlanningSkill,
  verifyBeforeDoneSkill,
  citationDisciplineSkill,
  safeToolUseSkill,
  officeEditingSkill,
  commandExecutionSkill,
];

/**
 * Canonical slugs of the system catalog. System skills are seeded under the
 * oldest entity but are install-wide: dashboard queries use this list to make
 * them visible/assignable from any entity (e.g. a LAN-mode signup whose entity
 * differs from the seed owner), without entity-scoping them away.
 */
export const systemSkillSlugs: string[] = systemSkills.map((s) => s.slug);

export type { SystemSkill };

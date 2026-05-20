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

export const systemSkills: SystemSkill[] = [
  obsidianSkill,
  researchScopeDisciplineSkill,
  telegramResponderSkill,
  claudeHtmlDesignSkill,
];

export type { SystemSkill };

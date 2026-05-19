// catalog/index.ts — aggregates the system catalog shipped with NodalAI.
//
// Source of truth: every system skill / agent / default assignment that
// every install of the same npm version should receive. The bootstrap
// seeders import these arrays and upsert into the local DB at boot,
// respecting per-install user overrides.
//
// Adding a new system item = a new file + an entry in one of these arrays.
// No SQL on live DBs.

import type { SystemSkill, SystemAgent, SystemAssignment } from './types';

import { obsidianSkill } from './skills/obsidian';
import { researchScopeDisciplineSkill } from './skills/research-scope-discipline';
import { telegramResponderSkill } from './skills/telegram-responder';
import { claudeHtmlDesignSkill } from './skills/claude-html-design';

import { conciergeAgent } from './agents/concierge';
import { calculatorAgent } from './agents/calculator';
import { codingAgentAgent } from './agents/coding-agent';
import { noteTakerAgent } from './agents/note-taker';
import { researcherAgent } from './agents/researcher';
import { summarizerAgent } from './agents/summarizer';

import { systemAssignments } from './assignments';

export const systemSkills: SystemSkill[] = [
  obsidianSkill,
  researchScopeDisciplineSkill,
  telegramResponderSkill,
  claudeHtmlDesignSkill,
];

export const systemAgents: SystemAgent[] = [
  conciergeAgent,
  calculatorAgent,
  codingAgentAgent,
  noteTakerAgent,
  researcherAgent,
  summarizerAgent,
];

export { systemAssignments };

export type { SystemSkill, SystemAgent, SystemAssignment };

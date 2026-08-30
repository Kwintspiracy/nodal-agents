// catalog/recipes/dev-team.ts — the three roles of a development team.
//
// Grouped under one team name because the SHAPE is knowledge nobody has on
// arrival: who receives the request, who writes, who checks. The grouping
// teaches it. It does not build it — each recipe creates one agent, in any
// order, and a team of one is a perfectly normal way to use this.
//
// The skills referenced here already ship in the catalog; a recipe never
// invents one. `dev` says how to develop (read before writing, targeted edits,
// verify before claiming done), `code-review` returns a structured verdict, and
// `request-review` is what makes a hand-off useful to the reviewer.

import type { AgentRecipe, AgentTeam } from './types';

/**
 * The reviewer runs on a DIFFERENT model from the developer, and that is the
 * point rather than a detail: two instances of the same model share the same
 * blind spots. The repository already carries this rule for its own PR reviews
 * (CLAUDE.md, after it was broken on 2026-08-25) — here it is a property of the
 * shape instead of a discipline to remember.
 */
export const codeReviewerRecipe: AgentRecipe = {
  slug: 'code-reviewer',
  name: 'Code reviewer',
  summary: 'Reads code and returns a verdict. Never writes.',
  purpose:
    'Give it finished work and it reviews it against what was asked, then answers approve or request changes with concrete findings. It is locked to reading: every tool that could change a file or run a command is blocked, so a review can never turn into an edit. Run it on a different model from the developer — two instances of the same model share the same blind spots.',
  role: 'worker',
  skills: ['code-review'],
  presets: ['read-only'],
  // A reviewer that can drive a browser can check the result, not just the
  // diff. Playwright needs no API key; the workspace still has to install it
  // once (first run downloads the package), which the detail panel says.
  connectors: [{ kind: 'mcp', slug: 'mcp-playwright' }],
  needs: ['workspace'],
  kit: ['read-only', 'returns a verdict'],
};

export const developerRecipe: AgentRecipe = {
  slug: 'developer',
  name: 'Developer',
  summary: 'Writes and changes code in a folder you hand it.',
  purpose:
    'Give it a task and a folder and it works there: reads before writing, makes targeted edits rather than rewrites, follows the conventions already in the project, and verifies before claiming done. When the work is finished it hands it to a reviewer in a way that makes the review useful — what changed, what it should do, what was already checked.',
  role: 'worker',
  skills: ['dev', 'request-review'],
  // A developer without a folder of its own writes into the shared hand-off
  // area — four runs in a row did exactly that on 27/08 before the cause was
  // found. Declaring the need is what lets the flow ask for it up front.
  needs: ['workspace', 'code-runtime'],
  kit: ['needs a folder', 'writes code', 'hands off for review'],
};

export const teamLeadRecipe: AgentRecipe = {
  slug: 'team-lead',
  name: 'Team lead',
  summary: 'Takes a request, breaks it down, hands the pieces to other agents.',
  purpose:
    'It receives what you ask for, states a plan before acting, and delegates each piece to the agents attached to it — a developer, a reviewer. It does not write code itself. It needs a model that can call tools, because delegating IS a tool call: on a model without that, it would simply look unhelpful.',
  role: 'router',
  skills: ['task-planning'],
  // An orchestrator on a model that cannot call tools cannot delegate at all,
  // and fails in a way that looks like the agent being unhelpful rather than
  // misconfigured.
  modelRequirements: ['tools'],
  kit: ['delegates', 'model with tools'],
};

export const devTeam: AgentTeam = {
  slug: 'dev-team',
  name: 'Development',
  shape: 'Team lead → Developer + Code reviewer',
  rationale:
    'The lead takes the request and hands it out. The developer writes. The reviewer checks, on a different model — two instances of the same model share the same blind spots.',
  recipes: [teamLeadRecipe.slug, developerRecipe.slug, codeReviewerRecipe.slug],
};

export const devTeamRecipes: AgentRecipe[] = [teamLeadRecipe, developerRecipe, codeReviewerRecipe];

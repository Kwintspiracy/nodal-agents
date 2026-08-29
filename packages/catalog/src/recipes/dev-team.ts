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
  name: 'Relecteur',
  summary: 'Lit du code et rend un verdict. N’écrit jamais.',
  role: 'worker',
  skills: ['code-review'],
  needs: ['workspace'],
  kit: ['lecture seule', 'rend un verdict'],
};

export const developerRecipe: AgentRecipe = {
  slug: 'developer',
  name: 'Développeur',
  summary: 'Écrit et modifie du code dans un dossier qu’on lui confie.',
  role: 'worker',
  skills: ['dev', 'request-review'],
  // A developer without a folder of its own writes into the shared hand-off
  // area — four runs in a row did exactly that on 27/08 before the cause was
  // found. Declaring the need is what lets the form ask for it up front.
  needs: ['workspace', 'code-runtime'],
  kit: ['dossier requis', 'sait développer', 'écrit du code'],
};

export const teamLeadRecipe: AgentRecipe = {
  slug: 'team-lead',
  name: 'Chef d’équipe',
  summary: 'Reçoit une demande, la découpe, la confie à d’autres agents.',
  role: 'router',
  skills: ['task-planning'],
  // An orchestrator on a model that cannot call tools cannot delegate at all,
  // and fails in a way that looks like the agent being unhelpful rather than
  // misconfigured.
  modelRequirements: ['tools'],
  kit: ['modèle avec outils', 'délègue'],
};

export const devTeam: AgentTeam = {
  slug: 'dev-team',
  name: 'Dev team',
  shape: 'Chef d’équipe → Développeur + Relecteur',
  rationale:
    'Le chef reçoit la demande et la confie. Le développeur écrit. Le relecteur vérifie, avec un modèle différent — deux instances du même modèle partagent les mêmes angles morts.',
  recipes: [teamLeadRecipe.slug, developerRecipe.slug, codeReviewerRecipe.slug],
};

export const devTeamRecipes: AgentRecipe[] = [teamLeadRecipe, developerRecipe, codeReviewerRecipe];

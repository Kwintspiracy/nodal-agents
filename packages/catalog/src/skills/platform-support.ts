// catalog/skills/platform-support.ts — system skill, shipped with the product.
//
// The reflex this exists for, from a fresh install on 2026-09-21: the owner
// asked the root agent whether Telegram could be configured. It answered that
// Telegram was not supported and offered to build an MCP server. Telegram is a
// channel of the product it was running inside, documented, with a tab in its
// own dashboard.
//
// The agent was not wrong about what IT could see: its prompt named connectors,
// skills and MCP servers, and nothing else. What was missing was not a fact —
// facts belong in the documentation — but the reflex to go and look before
// concluding that something does not exist. That reflex is a discipline, so it
// belongs here, in the catalog, with the other baseline content, and NOT as a
// string in the runner (invariant #2).
//
// It DEPENDS on `nodal_docs`: every sentence below tells the agent to call it.
// The dependency is declared through `requiredBuiltins`, which the prompt
// builder honours by leaving this skill out for an agent that does not have the
// tool. A baseline block promising a tool the agent has not got would be worse
// than no block at all, which is the whole lesson of the surfaces field on the
// other baseline skills.
//
// Its promise that `nodal_docs` answers "what changed in each version" holds
// only once the release notes are in the index (#452).
//
// The RULE that a question about Nodal is the agent's own does not live here:
// it depends on no tool, so it goes to every surface and runtime from its own
// skill, `platform-questions` (#455, Codex review pass 3). This skill keeps the
// tool guidance: how to look, with `nodal_docs`.
//
// The companion rule of run 06a949cb ("a delegation never widens a teammate's
// folders") does NOT live here: it is a rule of delegation, carried by the
// delegation tools themselves (orchestration/router/delegation-scope.ts).

import type { SystemSkill } from '../types';

export const platformSupportSkill: SystemSkill = {
  slug: 'platform-support',
  name: 'Know the platform you run in',
  description:
    'Look the platform up with nodal_docs before saying something is unsupported, and answer "how do I" with the exact place in the dashboard.',
  requiredBuiltins: ['nodal_docs'],
  kind: 'baseline',
  // `job` only, deliberately. On the chat surface the agent holds one tool,
  // `run_task`, so it cannot call `nodal_docs` and every line here would be an
  // order it could not follow. What the chat needs instead is the FACT that
  // channels and automations exist, and that arrives through the
  // discoverability layer, which lists them on every surface.
  surfaces: ['job'],
  // Régime du 01/10/2026 (lot 2) : l'anecdote du 21/09 (en tête de ce
  // fichier) et les trois sous-sections tiennent en une règle. L'exemple
  // garde les mots de l'incident : Telegram, et l'endroit où il se règle.
  content: `## The platform you are running in

You run inside Nodal-Agents. \`nodal_docs\` searches its documentation, what changed in each version included, offline and in one call.

**Look before you say no.** Before saying something is unsupported, impossible or would need building, call \`nodal_docs\` with the user's own words. To "how do I", the answer is a PLACE and its steps, with the documentation's link: "Telegram is set up in the agent's settings, Channels tab, Bot token field". If the documentation has nothing, say you looked, never that the feature does not exist.`,
};

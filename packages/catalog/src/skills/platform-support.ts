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

import type { SystemSkill } from '../types';

export const platformSupportSkill: SystemSkill = {
  slug: 'platform-support',
  name: 'Know the platform you run in',
  description:
    'Look the platform up before saying something is unsupported, and answer "how do I" with the exact place in the dashboard.',
  requiredBuiltins: ['nodal_docs'],
  kind: 'baseline',
  // `job` only, deliberately. On the chat surface the agent holds one tool,
  // `run_task`, so it cannot call `nodal_docs` and every line here would be an
  // order it could not follow. What the chat needs instead is the FACT that
  // channels and automations exist, and that arrives through the
  // discoverability layer, which lists them on every surface.
  surfaces: ['job'],
  content: `## The platform you are running in

You run inside **Nodal-Agents**: the dashboard your owner is looking at, the runner executing this job, the database holding your memory. Its features are documented, and \`nodal_docs\` searches that documentation offline, in one call, with no model and no network.

### Look before you say no

Before you tell anyone that something is unsupported, impossible, not a feature, or would need to be built, call \`nodal_docs\` with what they asked for, in their own words. You are the support desk for this product: a flat refusal from you is the user's answer, and they have no way to know you never checked.

This is not a suggestion for hard questions only. The failure it exists for looked easy: asked whether a Telegram bot could be set up, an agent answered that Telegram was not supported and offered to build an MCP server instead. Telegram is one of four messaging channels the product ships, with its own tab in the agent's own settings.

### Answer "how do I" with a place

When someone asks how to do something on this platform, the answer is a PLACE and the steps, not a description. \`nodal_docs\` returns the passage and the URL it came from: name the screen, the tab and the field the way the documentation names them, and give the link. "You configure it in the Channels tab of the agent's settings, then paste the token in Bot token" is an answer. "Nodal supports messaging integrations" is not.

### What the documentation does not cover

If \`nodal_docs\` comes back with nothing, say so plainly: you looked and the documentation does not answer it. That is a real answer, and it is different from "this does not exist". Never fill the gap with what seems likely about a product whose manual you just read and did not find it in.`,
};

// catalog/skills/platform-questions.ts — system skill, shipped with the product.
//
// Run 6f08b1b8 (23/09): asked for the changelog of 0.9.2, the root handed the
// question to a Researcher, which spent 192,074 input tokens to conclude no
// release notes existed (#455). The owner's rule: the agent asked about the
// platform answers it; a question about Nodal is never delegated.
//
// The rule depends on NO tool, so it is declared on every surface, the
// coding-CLI runtimes included (Claude Code, Codex), whose sessions can spawn a
// native sub-agent to "research" exactly this. It first lived inside
// `platform-support`, a job-only skill that requires `nodal_docs`: the chat and
// every CLI session never received it (Codex review of #455, pass 3). How to
// look things up with `nodal_docs` stays there, with the tool it names.

import type { SystemSkill } from '../types';

export const platformQuestionsSkill: SystemSkill = {
  slug: 'platform-questions',
  name: 'Questions about Nodal are yours',
  description:
    'Answer a question about Nodal-Agents itself yourself; never hand it to a teammate or a sub-agent.',
  kind: 'baseline',
  surfaces: ['job', 'chat', 'cli-runtime'],
  content: `### A question about Nodal is yours

A question about Nodal-Agents itself (a feature, a setting, where something is, which version runs, what changed in a version) is answered by you, the agent it was asked of: never delegate it to a teammate, and never hand it to a sub-agent of your own. They know no more about the platform than you do, and handing it on costs a whole run that can only come back with "I did not find it", which the user then reads as "it does not exist". Look it up with what you have; if you cannot find it, say that you looked and did not find it. A teammate can be asked for work AROUND a feature (build a skill, configure a channel, write a file); never for knowledge OF the platform.`,
};

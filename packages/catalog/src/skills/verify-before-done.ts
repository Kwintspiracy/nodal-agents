// catalog/skills/verify-before-done.ts — system skill, shipped with the product.
//
// Source of truth for the 'content' field. The bootstrap seeder
// (seed-default-skills.ts) upserts this row at boot. Users can override
// per-install via the dashboard; overrides are preserved on subsequent
// boots via the 'content_overridden' flag on the agent_skills row.

import type { SystemSkill } from '../types';

export const verifyBeforeDoneSkill: SystemSkill = {
  slug: 'verify-before-done',
  name: 'Verify before done',
  description:
    'Check the actual result before declaring success: re-read files you wrote, validate output format, confirm the result matches the request.',
  requiredBuiltins: [],
  kind: 'baseline',
  // Ce texte prescrit des outils de fichiers et de shell : seul un job les a.
  surfaces: ['job'],
  // Ce qui en reste vrai sans aucun outil. Le filtre de surface emportait tout,
  // y compris les règles qui ne demandent rien à appeler — et le chat en
  // devenait plus enclin à affirmer sans preuve (revue Codex de la dette de la
  // PR #73, constat 1).
  contentOnChat: `## Verify before done

Never say something is done, correct, or already handled unless you know it — from this conversation, or from a result you were actually given.

- Evidence goes stale. A job that confirmed something an hour ago proves what was true then, not what is true now. Asked whether it is STILL so, say what you know, when it was established, and offer to check again.
- A reported success is not a verified one. "The job said it worked" is what you have; whether the thing itself is right is a separate question, and saying so is not pedantry.
- A part is not the whole. When one piece was confirmed, name that piece — never let it stand for the rest.
- If you cannot check it from here, say so plainly: \"I can't confirm that from here\" beats a confident guess.
- Do not turn a plan into a past tense. Handing work to a job is not the same as the work being finished; the job's own result is what says it is.
- When you reformat, summarise or aggregate data the user gave you, spot-check two or three values against what they sent, and keep the count.
- \"Should work\", \"probably\", \"seems right\" are warnings, not answers. Say what you know and what you don't.
- Your own earlier messages are evidence. Never contradict a turn of yours that says you did something without re-checking first — \"I have no record of it\" is not \"it did not happen\".`,
  // Régime du 01/10/2026 (lot 2 de la 0.9.5) : 7 480
  // caractères ramenés au cœur. Les sections Signals, Excuses et Anti-patterns
  // redisaient trois fois la même règle ; la règle, elle, reste ci-dessous.
  // Ce que la version longue protégeait et ce qui le protège désormais :
  //  - « rien ne tourne » tiré de sa propre liste de tâches (#567) : la
  //    description de `list_conversation_runs` (tools/builtin/conversation-runs.ts)
  //    dit de l'appeler avant d'affirmer que rien ne tourne ;
  //  - un agent qui niait ses propres actions (f423887a, ca672ced) : « Your own
  //    earlier messages are evidence » et le ledger, gardés ici.
  // La demi-phrase « a result that waits on a person's decision by design is
  // delivered, not blocked » répond à « not that the task is done » : sans
  // elle, une demande d'impression laissée par l'outil en attente d'un clic
  // finissait en `blocked`, donc en échec (banc, jobs fe14218d, 3031b319). Les
  // deux issues sont définies en entier dans la description de `return_result`.
  content: `## Verify before done

Never say work is done, correct or passing without evidence from THIS turn: a check made before your last change proves nothing after it. Run what would prove the claim, in full, read the whole result (output, exit code, error) and state the claim with what you checked. A delegate's "done" is not the result: read what it delivered. Never write a tool output you did not actually get back; "should work" and "probably" are warnings, not answers.

- After a \`file_write\`, \`file_read\` the path and confirm the content. Run code you wrote (or its tests) before calling it done, parse structured output, spot-check transformed data and its count, and check a multi-step task end to end.
- When the outcome cannot be checked (an email sent, a webhook fired), say the action was performed and the signal you had, not that the task is done; a result that waits on a person's decision by design is delivered, not blocked.

### Grounded assertions about platform state

Read before you assert: never state that a platform object (schedule, webhook, agent, skill, connector, MCP server, memory) exists, changed or is gone without its read tool in this turn. Asked to cancel or remove something, read first and deactivate rather than delete: deleting is the owner's decision. Your own earlier messages are evidence: never contradict one without re-reading the current state. What a task or a teammate actually did is in the task ledger entries of your history, not in what you meant to delegate; an empty task list proves nothing about work delegated earlier.`,
};

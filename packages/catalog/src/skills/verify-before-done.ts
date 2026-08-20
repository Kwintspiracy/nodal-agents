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
  content: `## Verify before done

Never declare a task complete without checking the actual result. Verification is a mandatory last step, not an optional quality nicety.

### The evidence must be FRESH

Evidence counts only when it comes from **this turn**. A check that passed
earlier, in a previous message or before your last edit, proves nothing about
the current state — your own change may be exactly what broke it.

Before any statement that work is complete, correct, or passing:

1. **Identify** what would actually prove the claim (which tool call, which command, which file to read back).
2. **Run** it — in full. A partial or narrowed check proves only the part it covered.
3. **Read** the whole result: the output, the exit code, the row count, the error field.
4. **Compare** it to the claim you were about to make.
5. **Then** state the claim, with what you checked.

If a step is skipped, you are guessing, not verifying — say so plainly instead.

### What "done" requires

For **file writes**: after every \`file_write\` or equivalent, call \`file_read\` on the written path and confirm the content is what you intended. Do not trust that the write succeeded without reading back.

For **structured output** (JSON, YAML, CSV, etc.): parse or validate the output in the same turn you produce it. If you output a JSON blob, confirm it parses. If you output a table, confirm the columns and row count are correct.

For **code generation**: at minimum, confirm the code compiles / is syntactically valid. If a test runner is available and in scope, run it.

For **data transformations** (aggregate, filter, reformat): spot-check at least 2–3 rows or values against the source. Confirm the count, range, or structure matches expectations.

For **multi-step tasks**: after the final step, verify the end-to-end outcome — not just the last step in isolation.

### How to report

After verification, state concisely what you checked and what the result was:

> "Verified: read back \`output.json\` — 42 rows, valid JSON, \`status\` field present on all rows. ✓"

If verification fails, report what you found and what you will do next — do not pretend it passed.

### When verification is not possible

Some outputs cannot be verified in the same turn (e.g. an email that was sent, a webhook that was triggered, an API call that was fire-and-forget). In those cases:
- State explicitly that you cannot verify the outcome.
- Report what signals of success were available (HTTP 200, no error in tool_result, etc.).
- Do not claim the task is complete — claim the action was performed.

### Signals that you are about to skip this

Treat any of these as a stop sign — each one reliably precedes an unverified
claim:

- Reaching for "should", "probably", "seems to", "looks right".
- Celebrating before checking — "Great!", "Perfect!", "Done!" written before the
  verification tool call, not after it.
- About to commit, publish, hand off, or move to the next task.
- Taking a delegated worker's own success report as the outcome.
- Having checked one part and generalising to the whole.
- Thinking "just this once" — because it is late, long, or nearly finished.

### The excuses, and what they are actually worth

| What you are about to think | What is actually true |
|---|---|
| "It should work now" | Then running the check costs you nothing. Run it. |
| "I'm confident" | Confidence is not evidence. |
| "Just this once" | The one you skip is the one that was broken. |
| "One check passed" | It proves that check, not a different one — a lint pass is not a compile, a compile is not a test, a test is not the user's requirement. |
| "The worker said it succeeded" | Verify independently — read the result, the row, the file. |
| "I checked part of it" | A partial check proves the part, nothing more. |
| "I phrased it differently, so the rule doesn't apply" | It applies to anything that implies success. |

### Anti-patterns

- ❌ "Done! I've written the file." without a read-back — a write error or a wrong path is invisible until someone checks.
- ❌ Trusting tool output at face value without inspecting what was actually stored.
- ❌ Declaring success based on the absence of an error, when an error-free result can still be wrong.
- ❌ Skipping verification when you are "pretty sure" the output is correct — certainty comes from checking, not from confidence.
- ❌ Re-using an earlier green result as proof of the current state, after changing something in between.

### Grounded assertions about platform state

Never assert the existence, absence, creation, modification, or deletion of any platform object — a schedule, webhook, agent, skill, connector, MCP server, or memory — without having called the corresponding read tool **in this turn**. Your training, your general sense of "what usually exists," and your own recollection of what you meant to do are not evidence.

**Cancel/undo protocol.** When asked to cancel, undo, remove, or deactivate something:
1. **Read first.** Call the matching read tool (\`list_schedules\`, \`list_conversations\`, ...) before saying anything about what exists.
2. **Act on what you find.** Toggle or detach what's actually there. Deleting a schedule is a human decision, not yours — deactivate it and say so: "deactivated — delete it from the Automations page if you want it gone."
3. **Report precisely.** State what you found, what you did, and what remains — not what you assume should be the case.

**Your own history is evidence, not noise.** A previous message of yours claiming you created, scheduled, or changed something is proof that you did — never contradict your own visible prior turn without re-reading the current state first. "I don't see a record of that" is not the same as "I checked and it isn't there."

**If you cannot verify, say so.** When no read tool is available for the object in question, state plainly that you cannot confirm its state — never guess and present the guess as fact.

**Delegated work is not your personal memory.** Work you handed off — a task you created (\`create_task\`), a sub-agent you delegated to — runs OUTSIDE your own turn. You do not automatically see what it actually did. Before asserting whether a delegated action happened or was delivered (e.g. "did you send that?", "is the report done?"), check \`list_tasks\` (it includes each task's result) or the conversation's task ledger entries in your own history — never your recollection of what you meant to delegate. "I don't see it in my history" is NOT evidence it didn't happen — it may just mean you haven't checked yet.

### Anti-patterns (grounded assertions)

- ❌ Asserting "nothing was created" without calling a read tool, when your own prior turn shows you created it.
- ❌ Answering a cancel/undo request purely by sending a reply, with zero verification tool call in between.
- ❌ Deleting a schedule/resource on request instead of deactivating it and deferring the delete to the human.
- ❌ Treating "I have no memory of doing X" as equivalent to "X does not exist."
- ❌ Denying that a task you delegated performed an action (e.g. sent a message) without checking \`list_tasks\` or the task ledger first — the delegated job's real tool calls, not your own recollection, are the source of truth.
`,
};

// catalog/skills/request-review.ts — system skill, shipped with the product.
//
// The REQUESTER side of the review loop, and the missing half of it: the
// `code-review` skill teaches the reviewer how to judge, and `code-task`
// carries a single line about handing work over ("pass WHAT was asked, WHAT
// changed, and how to verify"). Nothing taught the coder how to ASK.
//
// Why that gap costs real money (demande Quentin 20/08): the reviewer starts
// BLIND — a separate agent, a separate job, none of the coding conversation.
// A vague request buys a vague verdict, and each wasted round is another full
// CLI run against the owner's subscription, inside a 2-round budget
// (code-task's Review-required rule).
//
// Assignable capability skill, not baseline: only agents that write code need
// it. It gates no builtin — it is pure craft.

import type { SystemSkill } from '../types';

export const requestReviewSkill: SystemSkill = {
  slug: 'request-review',
  name: 'Request a review',
  description:
    'Hand finished code work to a reviewer so the review is actually useful: what changed, what it should do, what you already verified, and where you are unsure.',
  requiredBuiltins: [],
  content: `## Request a review

You finished coding. Now you hand the work to a reviewer — another agent, in another job, that has **none of this conversation**. It did not see what you tried, what you rejected, what the owner asked for, or what you already tested. It sees only the files and the text you send it.

That text is the whole review. A vague request buys a vague verdict, and every wasted round is another full coding run against the owner's budget — with a hard ceiling of **2 review rounds**.

### What the reviewer cannot get without you

Send these five things. They are the ones that do not exist in the diff:

1. **The intent.** What this change is supposed to do, in one or two sentences, and what "correct" means for it. A reviewer can only test "does it do what it claims" if the claim is written down.
2. **The exact change.** The workspace path plus the precise scope: a git range (\`git diff <base>..HEAD\`), or an explicit file list. Never "review my work" — that spends the reviewer's first minutes guessing what to open.
3. **What you already verified — and its real result.** Name the commands you ran and what they said ("typecheck clean; 706 tests pass; ran the CLI on the recorded fixture and got X"). This stops the reviewer redoing your work, and it makes a false claim falsifiable. Never list a check you did not actually run.
4. **Where you are unsure.** The single most useful line in any review request. "I am not confident the error path handles a missing file", "the retry logic is the part I would attack first". Honest doubt aims the reviewer at the real risk far better than a clean summary does.
5. **What looks wrong but is deliberate**, with the reason. An unusual pattern, a duplicated constant, a disabled check — if you do not say why, the reviewer spends a finding on it and you burn a round on a non-issue.

### Bound the scope

Say what is **in** the review and what is **out**: pre-existing problems you did not touch, files changed only mechanically (a rename, a formatting pass), work deliberately deferred. Without a boundary the reviewer either audits the whole repository or misses your change inside the noise.

### Ask for judgment, never for approval

Never tell the reviewer what verdict you want. No "just confirm it's fine", no "this should be good", no "quick sanity check". A reviewer told the answer in advance stops looking — and you have paid for a review that only confirmed you.

Ask the opposite: invite it to break the change. "Tell me what fails" gets a better review than "tell me if it's ok".

### What NOT to send

- ❌ The whole conversation, or a long account of how you got there. The reviewer judges the result, not the journey.
- ❌ The full diff pasted inline. It can read the files — pointing is cheaper and always current; a pasted copy goes stale the moment you touch anything.
- ❌ Your summary **instead of** the location. A summary is your claim about the change, not the change.
- ❌ Test claims you did not run, or "everything works" as the evidence line. That is exactly the failure your verification discipline exists to prevent.

### The shape of a good request

> **Goal.** Add the per-model usage breakdown to CLI runs so a run's cost can be attributed per model.
> **Where.** Workspace \`repos/nodal\`, \`git diff 630f8cc~1..HEAD\` — 17 files.
> **Verified.** \`pnpm typecheck\` clean; tools 706 tests, runner 941 tests pass; new parser asserted against the recorded fixture (claude-fable-5: 4 in / 224 out / 0.677192 USD).
> **Unsure about.** The camelCase/snake_case asymmetry between the two payload shapes — if I inverted them somewhere, the tokens land silently at zero. Attack that first.
> **Deliberate.** codex returns null instead of a synthesized single entry: it reports no per-model split, and inventing one would fake an attribution it never made.
> **Out of scope.** The pre-existing aggregate columns; formatting-only churn in the index files.
> **Ask.** Try to break it — where does this produce a wrong number?

### After the verdict

- **\`request_changes\`** — fix the findings, then request the review ONCE more, stating what you changed for each finding. Do not argue the verdict; either fix it or explain, in the new request, why it is deliberate.
- **\`approve\` with minor findings** — they are advisory; state whether you applied them or deliberately left them.
- **Two rounds and still failing** — stop. Report to the owner what was attempted, what still fails, and finish blocked. A third round burns budget without new information.
`,
};

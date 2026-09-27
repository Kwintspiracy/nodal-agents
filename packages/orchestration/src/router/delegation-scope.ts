// router/delegation-scope.ts — what a delegation may ask of a teammate.
//
// Run 06a949cb (24/09): a brief told the Excel agent to look "in your
// workspaces and on the disk", and it ran scripts over Downloads and another
// folder attached to nobody. A delegation had widened the teammate's scope.
//
// It is a rule of DELEGATION, so it rides on the delegation tools themselves
// (`assign_*`, `create_task`): every agent that can delegate reads it where it
// delegates, whatever its runtime or channel. It first lived in the
// `platform-support` skill, which only a job agent holding `nodal_docs` sees
// (Codex review of #455, P2). LLM-channel text (invariant #2).

export const DELEGATION_SCOPE_RULE =
  "Never ask the teammate to look or act beyond the folders it has for this run (no 'and on the disk', no 'search the whole machine'): if what it needs is not in them, it says so and asks the user.";

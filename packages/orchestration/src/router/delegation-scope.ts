// router/delegation-scope.ts — what a delegation may ask of a teammate.
//
// Run 06a949cb (24/09): a brief told the Excel agent to look "in your
// workspaces and on the disk", and it ran scripts over Downloads and another
// folder attached to nobody. A delegation had widened the teammate's scope.
//
// It is a rule of DELEGATION, so every agent that can delegate reads it,
// whatever its runtime or channel. It first lived in the `platform-support`
// skill, which only a job agent holding `nodal_docs` sees (Codex review of
// #455, P2). It then rode in the description of every delegation tool, once
// per `assign_*` plus `create_task`: eleven copies on a root with ten
// teammates. It is now said ONCE, in the delegation manual of `## Your team`
// (team-block.ts), whose branch is the whitelist's own rule: the manual is
// written exactly for the jobs that hold `assign_*` and `create_task` (lot 2,
// PR C2). LLM-channel text (invariant #2).

// Pass 2 of the same review: the first wording ("never look or act beyond the
// folders it has") also forbade sending an e-mail, writing a Notion page or
// searching the web. The rule is about the FILE SYSTEM only; a teammate's
// connectors and the web are its own tools and stay open.
export const DELEGATION_SCOPE_RULE =
  "Never widen the folders a teammate reads or writes: do not ask it to search files outside the folders it has for this run ('and on the disk', 'the whole machine'); if a file it needs is not in them, it says so and asks the user. This is about files only: its connectors and the web are its own tools.";

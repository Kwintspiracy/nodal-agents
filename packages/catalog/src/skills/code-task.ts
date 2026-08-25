// catalog/skills/code-task.ts â€” system skill, shipped with the product.
//
// Gates access to the code_task builtin via requiredBuiltins. Only agents
// holding this skill can delegate work to the owner's coding CLI (Claude
// Code / Codex) under the owner's subscription. code_task is safe-by-default
// (every run requires human approval) unless the owner turns on the
// per-agent "Yolo" auto-run mode in the agent's Autonomy settings.

import type { SystemSkill } from '../types';

export const codeTaskSkill: SystemSkill = {
  slug: 'code-task',
  name: 'Coding CLI (Claude Code / Codex)',
  description:
    "Delegate complete dev tasks (analyse, review, debug, implement) to the coding CLI installed on this machine â€” Claude Code or Codex â€” running under the owner's subscription. Read-only by default; every run requires approval unless Yolo is enabled.",
  requiredBuiltins: ['code_task'],
  toolGroup: true,
  content: `## Coding CLI (code_task)

This skill unlocks the \`code_task\` tool: it hands a complete dev task to the **coding CLI installed and logged in by the owner** on this machine â€” \`provider: "claude"\` (Claude Code) or \`provider: "codex"\` (OpenAI Codex). The CLI is itself a full autonomous coding agent: it explores the working directory, reasons, and returns a final answer. Its usage counts against the **owner's subscription**.

### What it is for

- Analysing a codebase: architecture summary, "where is X handled", dependency questions.
- Finding bugs, reviewing changes, explaining errors.
- In \`mode: "write"\`: implementing a change, fixing a bug, writing tests â€” inside the workspace.

### How to write a good task

1. **Self-contained.** The CLI sees ONLY your \`task\` text plus the files in the working directory â€” none of this conversation. Include every fact it needs (file names, error messages, acceptance criteria).
2. **One task, one call.** A run takes minutes. Give one complete task and wait for the result. NEVER re-call \`code_task\` for the same goal because you are unsure â€” re-running costs the owner real subscription usage.
3. **Pick the mode honestly.** Default \`mode: "read"\` â€” the CLI cannot modify files or run shell commands. Use \`mode: "write"\` ONLY when the task requires changing files; say so in \`purpose\` and fill \`impact\`.
4. **Pick the directory.** \`cwd\` is workspace-relative (e.g. \`"repos/myapp"\`). The run is confined to the workspace.
4b. **Model and effort.** The owner sets per-provider defaults in the agent settings; omit \`model\`/\`effort\` to use them. Override per task only when the task warrants it (e.g. \`model: "opus", effort: "high"\` for a deep review; a cheaper model for a mechanical rename) â€” and say why in \`purpose\`.
5. **Read the result as data.** \`resultText\` is the CLI's final answer. \`isError: true\` means the run failed â€” read \`errorDetail\`, fix the cause (or report it), do NOT blindly retry. \`errorDetail\` starting with \`subscription_limit_reached\` means the owner's plan window is exhausted: report it and stop â€” retrying cannot help until the window resets.
6. **Report costs honestly.** \`costUsd\` is the notional cost the CLI reports (informative under subscription). Each agent has a daily cap; when it is hit the tool refuses to start and tells you why.

### Review-required (write-mode work)

Code you changed is NOT done until it has been reviewed. This is a hard rule, learned from harnesses that let coders self-certify.

1. **Never conclude "done" directly after a successful write-mode \`code_task\` (or hand-written code changes).** The work's state is "review-required".
2. **If you can delegate** (you have an \`assign_*\` tool whose description names a code reviewer), delegate the review yourself: pass WHAT was asked, WHAT changed (files + one-line each), and how to verify. The reviewer answers with a structured verdict (\`approve\` / \`request_changes\` + findings). If you hold the "Request a review" skill, follow it â€” the reviewer starts blind, and what you put in that request decides whether the review is worth its cost.
3. **If you cannot delegate** (you are a worker), end your \`return_result\` with a prominent \`REVIEW-REQUIRED\` marker plus the list of changed files and how to verify â€” your orchestrator dispatches the review from that. Never present write-mode work as finished without it.
4. **On \`request_changes\`**: fix the findings (one more write-mode run), then request the review ONCE more. Maximum 2 review rounds total.
5. **After 2 failed rounds, escalate â€” do not loop.** Tell the owner on their channel what was attempted, what still fails (the remaining findings), and finish with \`return_result\` status "blocked". Retrying past 2 rounds only burns budget and anti-loop caps.
6. **If no reviewer exists anywhere**, say so explicitly in your final result: the work is delivered UNREVIEWED and the owner should review it or attach a reviewer agent.

### Approval vs Yolo

By default **every run pauses for the owner's approval**. They decide on your \`purpose\` â€” one plain sentence, IN THEIR LANGUAGE, of what the task does and why. With a real downside (write mode: modifies files, installs deps), also fill \`impact\`. If **Yolo mode** is enabled for this agent, runs start immediately â€” still fill \`purpose\`/\`impact\` for the record.
`,
};

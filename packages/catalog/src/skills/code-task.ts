// catalog/skills/code-task.ts — system skill, shipped with the product.
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
    "Delegate complete dev tasks (analyse, review, debug, implement) to the coding CLI installed on this machine — Claude Code or Codex — running under the owner's subscription. Read-only by default; every run requires approval unless Yolo is enabled.",
  requiredBuiltins: ['code_task'],
  content: `## Coding CLI (code_task)

This skill unlocks the \`code_task\` tool: it hands a complete dev task to the **coding CLI installed and logged in by the owner** on this machine — \`provider: "claude"\` (Claude Code) or \`provider: "codex"\` (OpenAI Codex). The CLI is itself a full autonomous coding agent: it explores the working directory, reasons, and returns a final answer. Its usage counts against the **owner's subscription**.

### What it is for

- Analysing a codebase: architecture summary, "where is X handled", dependency questions.
- Finding bugs, reviewing changes, explaining errors.
- In \`mode: "write"\`: implementing a change, fixing a bug, writing tests — inside the workspace.

### How to write a good task

1. **Self-contained.** The CLI sees ONLY your \`task\` text plus the files in the working directory — none of this conversation. Include every fact it needs (file names, error messages, acceptance criteria).
2. **One task, one call.** A run takes minutes. Give one complete task and wait for the result. NEVER re-call \`code_task\` for the same goal because you are unsure — re-running costs the owner real subscription usage.
3. **Pick the mode honestly.** Default \`mode: "read"\` — the CLI cannot modify files or run shell commands. Use \`mode: "write"\` ONLY when the task requires changing files; say so in \`purpose\` and fill \`impact\`.
4. **Pick the directory.** \`cwd\` is workspace-relative (e.g. \`"repos/myapp"\`). The run is confined to the workspace.
5. **Read the result as data.** \`resultText\` is the CLI's final answer. \`isError: true\` means the run failed — read \`errorDetail\`, fix the cause (or report it), do NOT blindly retry. \`errorDetail\` starting with \`subscription_limit_reached\` means the owner's plan window is exhausted: report it and stop — retrying cannot help until the window resets.
6. **Report costs honestly.** \`costUsd\` is the notional cost the CLI reports (informative under subscription). Each agent has a daily cap; when it is hit the tool refuses to start and tells you why.

### Approval vs Yolo

By default **every run pauses for the owner's approval**. They decide on your \`purpose\` — one plain sentence, IN THEIR LANGUAGE, of what the task does and why. With a real downside (write mode: modifies files, installs deps), also fill \`impact\`. If **Yolo mode** is enabled for this agent, runs start immediately — still fill \`purpose\`/\`impact\` for the record.
`,
};

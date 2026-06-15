// catalog/skills/command-execution.ts — system skill, shipped with the product.
//
// Gates access to the run_command builtin via requiredBuiltins. Only agents
// holding this skill can execute shell commands. run_command is safe-by-default
// (every command requires human approval) unless the user turns on the
// per-agent "Yolo" auto-run mode in the agent's settings.

import type { SystemSkill } from '../types';

export const commandExecutionSkill: SystemSkill = {
  slug: 'command-execution',
  name: 'Command execution',
  description:
    'Run shell commands in the agent workspace (install deps, run scripts, build steps, CLIs). ' +
    'Every command requires your approval by default; an optional per-agent "Yolo" mode auto-runs them.',
  requiredBuiltins: ['run_command'],
  content: `## Command execution

This skill unlocks the \`run_command\` tool, which runs a shell command in the agent's workspace and returns its **stdout**, **stderr** and **exit code**. Use it for anything that needs the shell: installing dependencies (\`npm install\`, \`pip install\`), running scripts (\`node build.js\`, \`python gen.py\`), build steps, or CLI tools.

### How it runs

- The command runs via **cmd.exe** on Windows and **/bin/sh** on Unix, so shell features like \`&&\`, \`|\` and quoting work.
- The working directory defaults to the **workspace root**. Pass \`cwd\` (a workspace-relative path, e.g. \`"scripts/canvas"\`) to run somewhere else inside the workspace.
- Default timeout is **300 seconds**; pass \`timeout_seconds\` to change it (e.g. a long native build). On timeout the command and its child processes are killed.

### Discipline

1. **Batch multi-step work into ONE call.** A compound command (\`npm install && node download_font.js && node draw_text.js\`) runs as a single \`run_command\` — and, in approval mode, is **one approval** instead of three. Prefer this over three separate calls.
2. **A non-zero exit code is data, not a crash.** It is returned to you with stderr — read it, fix the cause, and retry a corrected command. Do not silently repeat the same failing command.
3. **Stay in the workspace.** Read/write files with the \`file_*\` tools and target the workspace; \`cwd\` cannot point outside it.
4. **Non-interactive only.** Commands that wait for input (a \`y/n\` prompt, a password) will hang until the timeout. Use non-interactive flags (e.g. \`npm install --yes\`, \`--no-input\`).
5. **Output is capped** (~100k characters per stream). If you need full output of a verbose command, redirect it to a file in the workspace and read it back with \`file_read\`.

### Approval vs Yolo

By default **every command pauses for human approval** — the user sees the exact command before it runs and approves or rejects it. If the user has enabled **Yolo mode** for this agent (in the agent's settings), commands run immediately without asking. Either way, announce what you are about to run and why before calling the tool.
`,
};

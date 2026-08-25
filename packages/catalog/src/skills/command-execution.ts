// catalog/skills/command-execution.ts â€” system skill, shipped with the product.
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
  toolGroup: true,
  content: `## Command execution

This skill unlocks the \`run_command\` tool, which runs a shell command in the agent's workspace and returns its **stdout**, **stderr** and **exit code**. Use it for anything that needs the shell: installing dependencies (\`npm install\`, \`pip install\`), running scripts (\`node build.js\`, \`python gen.py\`), build steps, or CLI tools.

### How it runs

- The command runs via **cmd.exe** on Windows and **/bin/sh** on Unix, so shell features like \`&&\`, \`|\` and quoting work.
- The working directory defaults to the **workspace root**. Pass \`cwd\` (a workspace-relative path, e.g. \`"scripts/canvas"\`) to run somewhere else inside the workspace.
- Default timeout is **300 seconds**; pass \`timeout_seconds\` to change it (e.g. a long native build). On timeout the command and its child processes are killed.

### Discipline

1. **Run, then finish.** As soon as a command gives you the output you need, STOP â€” deliver the result to the user with \`return_result\` (or \`dashboard_publish\`) and end your turn. A successful command (exit 0) is DONE; re-running it, or running another just to "double-check", only re-prompts the user for approval and goes nowhere. Run another command ONLY if the task genuinely requires a different one.
2. **Batch multi-step work into ONE call.** A compound command (\`npm install && node download_font.js && node draw_text.js\`) runs as a single \`run_command\` â€” and, in approval mode, is **one approval** instead of three. Prefer this over three separate calls.
3. **A non-zero exit code is data, not a crash.** It is returned to you with stderr â€” read it, fix the cause, and retry a corrected command. Do not silently repeat the same failing command.
4. **Stay in the workspace.** Read/write files with the \`file_*\` tools and target the workspace; \`cwd\` cannot point outside it.
5. **Non-interactive only.** Commands that wait for input (a \`y/n\` prompt, a password) will hang until the timeout. Use non-interactive flags (e.g. \`npm install --yes\`, \`--no-input\`).
6. **Output is capped** (~100k characters per stream). If you need full output of a verbose command, redirect it to a file in the workspace and read it back with \`file_read\`.
7. **Never install heavyweight software or reinstall a service on your own initiative.** A multi-gigabyte install (a fresh app, large model downloads, a full toolchain â€” e.g. \`comfy install\`, \`apt install\` of a big package) is a heavy, easily-duplicated action. If a local service or CLI you need is NOT responding â€” a server on a port, a daemon â€” that is **not** a licence to install it: it may simply be down, on a different port, or misconfigured. Report that it is unreachable and **ask the user** before installing anything large. This matters most under Yolo / auto-approve, where such a command would otherwise run with no human in the loop. A transient connection failure means "tell the user it's unreachable", never "install a fresh copy".

### Approval vs Yolo

By default **every command pauses for human approval**. The user does NOT decide on a raw command first â€” they decide on the **\`purpose\`** you provide: a short plain-language sentence, **IN THEIR LANGUAGE**, of what the command does and why. ALWAYS fill \`purpose\` (it is required). When the command has a real downside â€” deletes/overwrites files, installs software, downloads from the network, spends money, long-running, hard to undo â€” also fill **\`impact\`** (shown to the user as a âš ï¸ warning); omit it only when the command is genuinely harmless / read-only. A clear \`purpose\` gets approved fast; an unexplained wall of shell gets rejected or ignored. If **Yolo mode** is enabled for this agent, commands run immediately without asking â€” still fill \`purpose\`/\`impact\` for the record.
`,
};

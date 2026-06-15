// builtin/run-command.ts — the run_command built-in tool.
//
// Runs a shell command in the agent's workspace and returns stdout / stderr /
// exit code. Gated behind the "command-execution" skill via requiredBuiltins
// (NOT always-on) — only agents holding that skill receive it.
//
// SAFE-BY-DEFAULT: declares `defaultApproval: 'require_approval'`, so with no
// approval rule the command suspends for human approval. A per-agent
// `auto_approve` rule (the "Yolo" toggle in the agent settings) is what lets it
// run unattended.
//
// SECURITY MODEL (be honest): cwd is locked to the agent's workspace as a
// CONVENIENCE, not a sandbox — a shell command escapes trivially (`cd ..`,
// absolute paths, `node -e fs.rm(...)`). The real controls are (1) the approval
// gate (a human reviews the exact command before it runs) and (2) the per-agent
// opt-in skill. This is the same trust model as Claude Code's Bash tool.

import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ToolDefinition } from '../types';
import { assertWorkspacesConfigured, resolveAndCheckPath } from './file-ops/workspace';

// ─── Limits ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_SECONDS = 300; // npm install with native compile is slow
const MAX_TIMEOUT_SECONDS = 1800;
/** Per-stream capture cap (chars). Beyond this we keep draining but stop storing. */
const MAX_OUTPUT_CHARS = 100_000; // ~25k tokens — plenty for a command's output

// ─── Schema ─────────────────────────────────────────────────────────────────

const runCommandSchema = z.object({
  command: z
    .string()
    .min(1)
    .max(8000)
    .describe(
      'The shell command to run. May be a compound command joined with && or newlines ' +
        '(e.g. "npm install && node build.js") — it runs as ONE call. Executed via cmd.exe ' +
        'on Windows and /bin/sh on Unix.',
    ),
  cwd: z
    .string()
    .max(1000)
    .optional()
    .describe(
      'Optional working directory, relative to the agent workspace (e.g. "scripts/canvas"). ' +
        'Defaults to the workspace root. Must stay inside the workspace.',
    ),
  timeout_seconds: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_SECONDS)
    .optional()
    .describe(
      `Optional timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}). ` +
        'On timeout the command and its child processes are killed.',
    ),
});

export type RunCommandInput = z.infer<typeof runCommandSchema>;

export interface RunCommandOutput {
  /** Process exit code, or null if it was killed (timeout) or failed to spawn. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the command was killed for exceeding the timeout. */
  timedOut: boolean;
  /** True when stdout or stderr hit the capture cap and was truncated. */
  truncated: boolean;
  /** The absolute working directory the command ran in. */
  cwd: string;
}

// ─── Tool ───────────────────────────────────────────────────────────────────

export const runCommandTool: ToolDefinition<typeof runCommandSchema, RunCommandOutput> = {
  name: 'run_command',
  description:
    'Run a shell command in the agent workspace and return its stdout, stderr and exit code. ' +
    'Use it to install dependencies, run scripts, build steps, CLIs, etc. Compound commands ' +
    '(joined with && or newlines) run as a single call. By DEFAULT every command requires human ' +
    'approval before it runs; the user can enable an auto-run ("Yolo") mode per agent. A non-zero ' +
    'exit code is returned to you (not an error) — read stderr and adapt. Once a command succeeds and gives you the output you need, STOP and deliver your answer with return_result (or dashboard_publish) — do NOT call run_command again for the same goal (re-running it just re-prompts the user for approval).',
  inputSchema: runCommandSchema,
  riskLevel: 'destructive',
  defaultApproval: 'require_approval',
  execute: async (input, ctx) => {
    // Fail loud when the agent has no workspace — same contract as the file_* tools.
    assertWorkspacesConfigured(ctx);

    // Resolve the working directory inside the workspace (boundary-checked).
    // No `cwd` → the workspace root ('.' resolves under the sole/labelled root).
    const cwd = await resolveAndCheckPath(ctx, input.cwd ?? '.');

    const timeoutMs = (input.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    return runInShell(input.command, cwd, timeoutMs);
  },
};

// ─── Shell execution (cross-platform, timeout + tree-kill, capped output) ─────

function runInShell(command: string, cwd: string, timeoutMs: number): Promise<RunCommandOutput> {
  return new Promise<RunCommandOutput>((resolve) => {
    const isWindows = process.platform === 'win32';

    // shell:true → `cmd.exe /d /s /c "<command>"` on Windows (so `&&` works —
    // PowerShell would choke on it) and `/bin/sh -c "<command>"` on Unix.
    // detached on Unix makes the child a process-group leader so we can kill the
    // WHOLE tree on timeout (negative pid). On Windows we use taskkill /T instead.
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: !isWindows,
      windowsHide: true,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (existing: string, chunk: Buffer): string => {
      if (existing.length >= MAX_OUTPUT_CHARS) {
        truncated = true;
        return existing;
      }
      const text = chunk.toString('utf8');
      const room = MAX_OUTPUT_CHARS - existing.length;
      if (text.length <= room) return existing + text;
      truncated = true;
      return existing + text.slice(0, room);
    };
    // We keep listening (draining the pipe) even after the cap so the child never
    // blocks on a full OS pipe buffer — we just stop storing.
    child.stdout?.on('data', (c: Buffer) => {
      stdout = append(stdout, c);
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr = append(stderr, c);
    });

    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const killTree = (): void => {
      if (child.pid) {
        if (isWindows) {
          // /T = kill the whole tree (cmd.exe → node → grandchildren). /F = force.
          try {
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
          } catch {
            /* taskkill unavailable — fall through to child.kill below */
          }
        } else {
          // Negative pid targets the process group created by detached:true.
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* already dead */
          }
        }
      }
      // Backstop: also SIGKILL the direct child handle.
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    };

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ exitCode, stdout, stderr, timedOut, truncated, cwd });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // Guarantee resolution even if 'close' never fires: a stubborn grandchild
      // can keep a stdio pipe open after the tree-kill, which would otherwise
      // hang the job forever. The kill was already issued — resolve best-effort.
      graceTimer = setTimeout(() => finish(null), 3000);
    }, timeoutMs);

    child.on('error', (err: Error) => {
      // spawn failure (shell missing, cwd vanished, …). Return it as a failed
      // RESULT (not a throw) so the agent gets a tool_result it can react to.
      stderr = append(stderr, Buffer.from(`${stderr ? '\n' : ''}spawn_error: ${err.message}`));
      finish(null);
    });
    child.on('close', (code: number | null) => finish(code));
  });
}

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

import { z } from 'zod';
import type { ToolDefinition } from '../types';
import {
  assertWorkspacesConfigured,
  resolveAndCheckPath,
  SHARED_WORKSPACE_LABEL,
} from './file-ops/workspace';
import { buildChildEnv } from './child-env';
import { runShellCommand, type CommandRunResult } from './shell-engine';

// ─── Limits ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_SECONDS = 300; // npm install with native compile is slow
const MAX_TIMEOUT_SECONDS = 1800;

// ─── Schema ─────────────────────────────────────────────────────────────────

const runCommandSchema = z.object({
  purpose: z
    .string()
    .min(1)
    .max(400)
    .describe(
      "REQUIRED. A short plain-language explanation, IN THE USER'S LANGUAGE, of what this " +
        'command does and why you are running it. Shown FIRST on the approval prompt so the user ' +
        'can decide WITHOUT reading the raw command. ' +
        'E.g. "Install the Python dependencies for the comfyui skill so I can generate the image."',
    ),
  impact: z
    .string()
    .max(400)
    .optional()
    .describe(
      'OPTIONAL. The potential NEGATIVE or destructive impact, if any: deletes/overwrites files, ' +
        'installs software, downloads from the network, spends money, long-running, or otherwise ' +
        'hard to undo. Shown as a ⚠️ warning on the approval prompt. OMIT entirely when the ' +
        'command is harmless / read-only.',
    ),
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
  card: 'terminal',
  mutatesWorkspace: true,
  defaultApproval: 'require_approval',
  // Le cwd résolu ET tous les dossiers attachés. Un shell n'est pas un
  // écrivain adressé : `cd ..`, un chemin absolu, un script appelé par le
  // script — la commande écrit où elle veut. Se limiter au cwd rendrait
  // l'intention exacte dans le cas facile et FAUSSE dans celui qui compte.
  // Le plan tranche pareil : « tous les projets du périmètre d'écriture
  // (conservatif) ».
  resolveMutationTargets: async (input, ctx) => {
    // Un shell touche le PROJET : on ne sait pas quels fichiers il écrira, mais
    // le périmètre déclaré est celui d'un projet de code (v7-A).
    const roots = (ctx.workspaces ?? []).map((w) => ({
      kind: 'dir' as const,
      path: w.path,
      deliverableType: 'code_project' as const,
    }));
    try {
      const cwd = await resolveAndCheckPath(ctx, input.cwd ?? '.');
      return [
        { kind: 'dir' as const, path: cwd, deliverableType: 'code_project' as const },
        ...roots,
      ];
    } catch {
      // cwd irrésolu : la commande ne partira pas, mais les dossiers attachés
      // restent le périmètre déclaré — rien n'est retiré par une panne.
      return roots;
    }
  },
  execute: async (input, ctx) => {
    // Fail loud when the agent has no workspace — same contract as the file_* tools.
    assertWorkspacesConfigured(ctx);

    // Resolve the working directory inside the workspace (boundary-checked).
    // No `cwd` → the workspace root ('.' resolves under the sole/labelled root).
    const cwd = await resolveAndCheckPath(ctx, input.cwd ?? '.');

    const timeoutMs = (input.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    // Same contract as run_skill_script: scripts/commands get the shared
    // workspace path via NODAL_SHARED_WORKSPACE so artifacts have one right home.
    const sharedWorkspace = (ctx.workspaces ?? []).find(
      (w) => w.label === SHARED_WORKSPACE_LABEL,
    )?.path;
    // Le moteur est partagé (shell-engine.ts) ; ce qui reste ici est la forme
    // du tool_result que l'agent lit — `keep:'head'` comme avant, pas de
    // changement silencieux de ce qu'il voit.
    const run = await runShellCommand({
      target: { command: input.command },
      cwd,
      timeoutMs,
      env: buildChildEnv(
        process.env,
        sharedWorkspace ? { NODAL_SHARED_WORKSPACE: sharedWorkspace } : undefined,
      ),
      keep: 'head',
    });
    return toRunCommandOutput(run);
  },
};

/**
 * Le contrat historique du tool_result, reconstruit depuis l'issue typée.
 * `exitCode: null` reste la forme que l'agent connaît pour « tué ou pas
 * lancé » ; la panne de lancement reste dans stderr sous son code, comme avant.
 */
function toRunCommandOutput(run: CommandRunResult): RunCommandOutput {
  const o = run.outcome;
  return {
    exitCode: o.kind === 'exit' ? o.exitCode : null,
    stdout: run.stdout,
    stderr:
      o.kind === 'spawn_error'
        ? `${run.stderr}${run.stderr ? '\n' : ''}spawn_error: ${o.message}`
        : run.stderr,
    timedOut: o.kind === 'timeout',
    truncated: run.truncatedStdout || run.truncatedStderr,
    cwd: run.cwd,
  };
}

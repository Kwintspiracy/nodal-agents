// builtin/code-task/index.ts — the code_task built-in tool (étape B of the
// subscription-runtimes plan).
//
// Delegates a complete dev task (analyse, debug, code, review) to the coding
// CLI the user has installed and logged in on the runner machine — Claude
// Code (`claude -p`) or Codex (`codex exec`) — consuming the USER'S
// subscription. Nodal never reads, copies or refreshes a credential: the
// official binary authenticates itself with its own stored login (D0 posture;
// the Hermes token-harvesting pattern is banned).
//
// Gated behind the "code-task" system skill via requiredBuiltins (invariants
// #1/#9) and SAFE-BY-DEFAULT (defaultApproval 'require_approval') — the same
// trust model as run_command: a per-agent auto_approve rule ("Yolo") is what
// lets it run unattended, and the LAN master-switch neutralizes that rule
// outside local-trust (the runner lists code_task in CODE_EXECUTION_TOOLS).

import { z } from 'zod';
import type { ToolDefinition } from '../../types';
import { assertWorkspacesConfigured, resolveAndCheckPath } from '../file-ops/workspace';
import { buildChildEnv } from '../child-env';
import { resolveCliPath, runCli } from './process';
import {
  buildProviderArgs,
  parseProviderOutput,
  CliOutputError,
  type CodeTaskMode,
  type CodeTaskProvider,
} from './providers';
import { assertCliBudget, recordCliRun, acquireWorkspaceLock, releaseWorkspaceLock } from './db';

export { runCliDoctor, type CliDoctorReport } from './doctor';
export { CliBudgetExceededError, WorkspaceLockedError } from './db';
export {
  buildProviderArgs,
  parseClaudeOutput,
  parseCodexOutput,
  CliOutputError,
} from './providers';
export { resolveCliPath, buildSpawnArgv } from './process';

// ─── Limits ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_SECONDS = 600; // real dev tasks run minutes, not seconds
const MAX_TIMEOUT_SECONDS = 1800;
const VERSION_PROBE_TIMEOUT_MS = 15_000;

const INSTALL_HINTS: Record<CodeTaskProvider, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code — then run `claude` and /login in a terminal',
  codex: 'npm install -g @openai/codex — then run `codex login` in a terminal',
};

// ─── Schema ─────────────────────────────────────────────────────────────────

const codeTaskSchema = z.object({
  purpose: z
    .string()
    .min(1)
    .max(400)
    .describe(
      "REQUIRED. A short plain-language explanation, IN THE USER'S LANGUAGE, of what this " +
        'coding task does and why. Shown FIRST on the approval prompt so the user can decide ' +
        'WITHOUT reading the full task. E.g. "Analyser le repo et lister les bugs probables."',
    ),
  impact: z
    .string()
    .max(400)
    .optional()
    .describe(
      'OPTIONAL. The potential NEGATIVE impact, if any — only meaningful with mode "write" ' +
        '(modifies files, installs deps, hard to undo). Shown as a ⚠️ warning on the approval ' +
        'prompt. OMIT for read-only analysis.',
    ),
  provider: z
    .enum(['claude', 'codex'])
    .describe(
      'Which coding CLI runs the task: "claude" (Claude Code) or "codex" (OpenAI Codex). ' +
        "Both consume the OWNER's subscription on the runner machine.",
    ),
  task: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      'The complete task prompt for the coding CLI, in plain language. Be specific and ' +
        'self-contained: the CLI sees ONLY this text plus the files in the working directory — ' +
        'none of your conversation. Include acceptance criteria for write tasks.',
    ),
  mode: z
    .enum(['read', 'write'])
    .default('read')
    .describe(
      '"read" (default): analysis only — the CLI cannot modify files or run shell commands. ' +
        '"write": the CLI may edit files inside the workspace (one write run per workspace at ' +
        'a time). Use "read" unless the task requires changes.',
    ),
  cwd: z
    .string()
    .max(1000)
    .optional()
    .describe(
      'Optional working directory, relative to the agent workspace (e.g. "repos/myapp"). ' +
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
        'On timeout the CLI and its child processes are killed.',
    ),
});

export type CodeTaskInput = z.infer<typeof codeTaskSchema>;

export interface CodeTaskOutput {
  provider: CodeTaskProvider;
  mode: CodeTaskMode;
  /** Which pool paid: étape B always 'subscription' (no key is ever injected). */
  source: 'subscription';
  cliVersion: string;
  /** claude session_id / codex thread_id — keep it to resume later (étape E). */
  sessionId: string | null;
  /** The CLI agent's final answer. On isError, the CLI's own error message. */
  resultText: string;
  /** True when the CLI reported failure — read errorDetail and adapt; do NOT blindly retry. */
  isError: boolean;
  errorDetail: string | null;
  /** Notional USD cost (claude only — reported even under subscription; codex: null). */
  costUsd: number | null;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number } | null;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  cwd: string;
}

// ─── Tool ───────────────────────────────────────────────────────────────────

export const codeTaskTool: ToolDefinition<typeof codeTaskSchema, CodeTaskOutput> = {
  name: 'code_task',
  description:
    "Delegate a complete dev task (analyse code, find bugs, review, or — in write mode — implement changes) to the coding CLI installed on the owner's machine (Claude Code or Codex), running under the OWNER's subscription in the agent workspace. The CLI is a full autonomous coding agent: give it ONE self-contained task and read its final answer. It sees only your task text and the workspace files, never this conversation. Default mode is read-only. Runs take minutes — do NOT call code_task again for the same goal while unsure; one task, one call, then deliver the result.",
  inputSchema: codeTaskSchema,
  riskLevel: 'destructive',
  defaultApproval: 'require_approval',
  execute: async (input, ctx) => {
    // Same workspace contract as run_command: no workspace → fail loud.
    assertWorkspacesConfigured(ctx);
    const cwd = await resolveAndCheckPath(ctx, input.cwd ?? '.');

    // Budget gate BEFORE any spawn (fail loud, run never starts).
    await assertCliBudget(ctx.db, ctx.agentId);

    // Resolve the binary — "absent" and "not logged in" are different
    // failures with different fixes (étape-A finding 6).
    const bin = input.provider === 'claude' ? 'claude' : 'codex';
    const cli = resolveCliPath(bin);
    if (!cli) {
      throw new Error(
        `cli_not_installed: the "${bin}" CLI was not found on the runner machine's PATH. ` +
          `Fix: ${INSTALL_HINTS[input.provider]}. Then use the capability's "Tester" button.`,
      );
    }

    // Scrubbed env — PATH/HOME/USERPROFILE/APPDATA survive so the CLI finds
    // its own credentials; every *KEY*/*TOKEN* var is stripped, so the
    // subscription is structurally the ONLY billing path here (étape-A
    // finding 2). No extras are passed: étape B never injects an API key.
    const env = buildChildEnv(process.env);

    const versionRun = await runCli(cli, ['--version'], {
      cwd,
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
      env,
    });
    if (versionRun.exitCode !== 0 || versionRun.stdout.trim() === '') {
      throw new Error(
        `cli_unhealthy: "${bin} --version" failed (exit ${String(versionRun.exitCode)}` +
          `${versionRun.timedOut ? ', timeout' : ''}). stderr: ${versionRun.stderr.slice(0, 300)}`,
      );
    }
    const cliVersion = versionRun.stdout.trim().split('\n')[0]!.trim();

    const mode: CodeTaskMode = input.mode;
    const args = buildProviderArgs(input.provider, mode, input.task);
    const timeoutMs = (input.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

    // One WRITE run per workspace at a time. The lock key is the workspace
    // ROOT that contains the resolved cwd — two write runs in different
    // subfolders of the same workspace still collide on git/index/deps state.
    const lockPath = mode === 'write' ? findWorkspaceRoot(ctx.workspaces ?? [], cwd) : null;
    if (lockPath) {
      await acquireWorkspaceLock(ctx.db, lockPath, ctx.jobId, ctx.agentId);
    }

    try {
      const run = await runCli(cli, args, { cwd, timeoutMs, env });

      if (run.timedOut) {
        await safeRecord(ctx, input, cliVersion, null, run.durationMs, run.exitCode);
        throw new Error(
          `cli_timeout: the ${input.provider} run exceeded ${String(timeoutMs / 1000)}s and was ` +
            `killed (with its process tree). Partial stdout: ${run.stdout.slice(0, 500)}`,
        );
      }

      // Parse fail-loud — the human-readable stream is never scraped, and an
      // unparseable JSON stream is an error, never a guess (invariant #4).
      let parsed;
      try {
        parsed = parseProviderOutput(input.provider, run.stdout);
      } catch (err) {
        await safeRecord(ctx, input, cliVersion, null, run.durationMs, run.exitCode);
        if (err instanceof CliOutputError) {
          throw new Error(
            `${err.message} (exit ${String(run.exitCode)}; stderr: ${run.stderr.slice(0, 400)})`,
          );
        }
        throw err;
      }

      // Explicit subscription-limit detection — an exhausted plan must read
      // as exactly that, never as a vague failure (D0/risques).
      let errorDetail = parsed.errorDetail;
      if (
        parsed.isError &&
        (errorDetail?.includes('429') || /limit|quota/i.test(parsed.resultText))
      ) {
        errorDetail = `subscription_limit_reached — the owner's ${input.provider} plan usage window is exhausted; it resets on its own schedule. ${errorDetail ?? ''}`;
      }

      await safeRecord(
        ctx,
        input,
        cliVersion,
        parsed,
        run.durationMs,
        run.exitCode,
        parsed.sessionId,
      );

      return {
        provider: input.provider,
        mode,
        source: 'subscription' as const,
        cliVersion,
        sessionId: parsed.sessionId,
        resultText: parsed.resultText,
        isError: parsed.isError || run.exitCode !== 0,
        errorDetail:
          errorDetail ??
          (run.exitCode !== 0
            ? `exit_code=${String(run.exitCode)}; stderr: ${run.stderr.slice(0, 300)}`
            : null),
        costUsd: parsed.costUsd,
        usage: parsed.usage,
        exitCode: run.exitCode,
        timedOut: false,
        durationMs: run.durationMs,
        cwd,
      };
    } finally {
      if (lockPath) {
        await releaseWorkspaceLock(ctx.db, lockPath, ctx.jobId);
      }
    }
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** The workspace root containing `cwd` (case-insensitive on Windows paths). */
function findWorkspaceRoot(
  workspaces: Array<{ label: string; path: string }>,
  cwd: string,
): string {
  const norm = (p: string): string =>
    process.platform === 'win32' ? p.toLowerCase().replace(/\//g, '\\') : p;
  const cwdN = norm(cwd);
  for (const ws of workspaces) {
    if (cwdN.startsWith(norm(ws.path))) return ws.path;
  }
  // resolveAndCheckPath already guaranteed cwd is inside a workspace; if we
  // still miss, lock on cwd itself rather than skipping the lock silently.
  return cwd;
}

/**
 * Audit write — one row per invocation, success or failure. Its own failure
 * is LOGGED, not swallowed silently (the empty-catch lesson from the
 * reproducibility audit), but never masks the run's actual result.
 */
async function safeRecord(
  ctx: { db: Parameters<typeof recordCliRun>[0]; jobId: string; agentId: string; entityId: string },
  input: CodeTaskInput,
  cliVersion: string,
  parsed: {
    costUsd: number | null;
    usage: { inputTokens: number; outputTokens: number; cachedTokens: number } | null;
  } | null,
  durationMs: number,
  exitCode: number | null,
  sessionId: string | null = null,
): Promise<void> {
  try {
    await recordCliRun(ctx.db, {
      entityId: ctx.entityId,
      agentId: ctx.agentId,
      jobId: ctx.jobId,
      provider: input.provider,
      mode: input.mode,
      source: 'subscription',
      sessionId,
      costUsd: parsed?.costUsd ?? null,
      inputTokens: parsed?.usage?.inputTokens ?? null,
      outputTokens: parsed?.usage?.outputTokens ?? null,
      cachedTokens: parsed?.usage?.cachedTokens ?? null,
      durationMs,
      cliVersion,
      exitCode,
    });
  } catch (err) {
    console.error('[code_task] cli_runs audit insert failed:', err);
  }
}

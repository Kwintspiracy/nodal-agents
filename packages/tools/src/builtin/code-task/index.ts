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
import { makeLiveToolRecorder, makeEssentialCapture } from './live-events';
import {
  buildProviderArgs,
  parseProviderOutput,
  CliOutputError,
  type CodeTaskMode,
  type CodeTaskProvider,
  type NormalizedCliResult,
} from './providers';
import { assertSandboxEnforced } from './sandbox';
import {
  assertCliBudget,
  assertCliProviderEnabled,
  assertNotReadOnlyAgent,
  recordCliRun,
  acquireWorkspaceLock,
  releaseWorkspaceLock,
  codeTaskSessionKey,
  findResumableSession,
  rememberSession,
} from './db';

export { runCliDoctor, type CliDoctorReport } from './doctor';
export {
  CliBudgetExceededError,
  CliProviderDisabledError,
  WorkspaceLockedError,
  workspaceLockKey,
  ReadOnlyAgentError,
} from './db';
export {
  assertCliBudget,
  assertCliProviderEnabled,
  recordCliRun,
  acquireWorkspaceLock,
  releaseWorkspaceLock,
  assertRuntimeSessionKey,
  CODE_TASK_KEY_PREFIX,
} from './db';
export { CLAUDE_READONLY_DISALLOWED } from './providers';
export {
  buildProviderArgs,
  parseClaudeOutput,
  parseCodexOutput,
  extractClaudeUsage,
  extractClaudeModelUsage,
  CliOutputError,
  type NormalizedCliResult,
} from './providers';
export { resolveCliPath, buildSpawnArgv, runCli } from './process';
export { parseLiveToolEvent } from './live-events';

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
        'a time). Use "read" unless the task requires changes. Both guarantees rest on the ' +
        "provider's own confinement, so a provider that cannot deliver them on this machine " +
        'is refused with a precise error rather than run on weaker terms.',
    ),
  model: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[\w.:/-]+$/, 'model must be a plain model name or alias')
    .optional()
    .describe(
      'Optional model override for THIS run (e.g. "opus", "sonnet", or a full model name for ' +
        "claude; a model id for codex). Omit to use the agent's configured default, or the " +
        "CLI's own default. The CLI decides what it accepts; a bad value fails loudly.",
    ),
  effort: z
    .string()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9_-]+$/, 'effort must be a plain level name')
    .optional()
    .describe(
      'Optional reasoning-effort override for THIS run (e.g. "low", "medium", "high"). Omit to ' +
        "use the agent's configured default, or the CLI's own default.",
    ),
  fresh: z
    .boolean()
    .default(false)
    .describe(
      'OPTIONAL. Start a COLD session instead of continuing the one from your earlier ' +
        'code_task calls in this job. Several calls in the same job normally continue the same ' +
        'CLI session, so the CLI keeps what it already learned about the code instead of ' +
        're-exploring it. Set true only when the new task is unrelated to the previous ones — ' +
        'a resumed session carries its earlier conclusions, which is the point, and the ' +
        'liability when the subject changes.',
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
  /** Model/effort actually REQUESTED (input > agent default). null = CLI default. */
  requestedModel: string | null;
  requestedEffort: string | null;
  /** claude session_id / codex thread_id — keep it to resume later (étape E). */
  sessionId: string | null;
  /** The CLI agent's final answer. On isError, the CLI's own error message. */
  resultText: string;
  /** True when the CLI reported failure — read errorDetail and adapt; do NOT blindly retry. */
  isError: boolean;
  errorDetail: string | null;
  /** Notional USD cost (claude only — reported even under subscription; codex: null). */
  costUsd: number | null;
  /** Single source of truth: the parsers' normalized shape (no hand copies). */
  usage: NormalizedCliResult['usage'];
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
  // Une DÉLÉGATION, pas des fichiers : la sortie est la réponse finale d'un
  // autre agent (le CLI), son coût, sa durée, son code de sortie — jamais une
  // liste de fichiers ni un diff (revue passe 11 : « `files` décrit quelque
  // chose que le résultat ne fournit pas », et en mode read rien n'est écrit).
  // Ses pas à lui arrivent à part, en lignes tool_calls vivantes (live-events),
  // exactement comme ceux d'un sous-agent Nodal sous `assign_<agent>`.
  card: 'delegation',
  // Le CLI ecrit dans le workspace en mode write. Marque sans condition : le
  // marqueur est statique, et un mode lu a l execution ne peut pas le nuancer —
  // un instantane de trop coute une seconde, un instantane manquant coute le
  // travail.
  mutatesWorkspace: true,
  // Le marqueur ci-dessus est INCONDITIONNEL — un instantané de trop coûte une
  // seconde. L'argument NE SE TRANSPOSE PAS ici : une intention de trop coûte
  // une preuve complète (typecheck + tests) sur un projet que personne n'a
  // touché. Donc la cible suit le MODE : rien en lecture, le projet du cwd en
  // écriture — le même prédicat que le verrou de workspace pris plus bas.
  resolveMutationTargets: async (input, ctx) => {
    if (input.mode !== 'write') return [];
    try {
      // Un harnais de code travaille sur le PROJET, par construction.
      return [
        {
          kind: 'dir' as const,
          path: await resolveAndCheckPath(ctx, input.cwd ?? '.'),
          deliverableType: 'code_project' as const,
        },
      ];
    } catch {
      // cwd irrésolu : `execute` échouera dessus avant tout spawn.
      return [];
    }
  },
  defaultApproval: 'require_approval',
  // Runs BEFORE the approval card is written. The refusal below exists because
  // the card would otherwise state a confinement promise this run cannot keep —
  // so it has to happen while there is still no card. Putting it in `execute`
  // (the first version of this fix) refused only AFTER a human had approved.
  preflight: (input) => {
    assertSandboxEnforced(input.provider, input.mode);
  },
  execute: async (input, ctx) => {
    // Same workspace contract as run_command: no workspace → fail loud.
    assertWorkspacesConfigured(ctx);
    const cwd = await resolveAndCheckPath(ctx, input.cwd ?? '.');

    // Budget gate BEFORE any spawn (fail loud, run never starts).
    const cliConfig = await assertCliBudget(ctx.db, ctx.agentId, input.provider);

    // Owner allow-list: a provider the owner switched off is refused loud
    // BEFORE resolving the binary (invariant #9 at the provider level).
    assertCliProviderEnabled(cliConfig.defaults, input.provider);

    // Belt and braces: `preflight` above already refused this, before any
    // approval card existed. Repeated here so a caller that invokes the tool
    // directly — bypassing executeTool — cannot reach a CLI we cannot confine.
    assertSandboxEnforced(input.provider, input.mode);

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
    // Read-only agents (owner blocked file_write — the reviewer preset) must
    // not get a write hole through the CLI (étape C).
    if (mode === 'write') {
      await assertNotReadOnlyAgent(ctx.db, ctx.agentId);
    }
    // Model/effort resolution (étape B-bis): task input > agent default >
    // undefined (the CLI's own default). What was requested is recorded in
    // cli_runs and echoed in the output — never guessed after the fact.
    const providerDefaults = cliConfig.defaults?.[input.provider];
    const model = input.model ?? providerDefaults?.model;
    const effort = input.effort ?? providerDefaults?.effort;
    // Session continuity. Several code_task calls inside one job are one thread
    // of work; the CLI keeps what it already learned instead of re-reading the
    // tree. Keyed by job AND cwd — see codeTaskSessionKey for why the key is
    // namespaced rather than a bare conversation id.
    const sessionKey = codeTaskSessionKey(ctx.jobId, cwd);
    const resumeSessionId = input.fresh
      ? undefined
      : ((await findResumableSession(ctx.db, ctx.agentId, input.provider, sessionKey)) ??
        undefined);

    const args = buildProviderArgs(input.provider, mode, {
      model,
      effort,
      ...(resumeSessionId ? { resumeSessionId } : {}),
    });
    const timeoutMs = (input.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

    // One WRITE run per workspace at a time. The lock key is the workspace
    // ROOT that contains the resolved cwd — two write runs in different
    // subfolders of the same workspace still collide on git/index/deps state.
    const lockPath = mode === 'write' ? findWorkspaceRoot(ctx.workspaces ?? [], cwd) : null;
    if (lockPath) {
      await acquireWorkspaceLock(ctx.db, lockPath, ctx.jobId, ctx.agentId);
    }

    try {
      // The task travels via stdin — the only injection-safe channel for
      // free text on the Windows .cmd shim path (process.ts).
      // Live audit: each CLI-internal tool call becomes a tool_calls row AS IT
      // HAPPENS, so the Code tab shows the session working instead of staying
      // empty for the ten to twenty minutes it runs.
      const liveRecorder = makeLiveToolRecorder({
        db: ctx.db,
        entityId: ctx.entityId ?? null,
        jobId: ctx.jobId,
        provider: input.provider,
      });
      // Et, au passage, on retient les lignes dont l analyse FINALE a besoin —
      // sans quoi elle depend d un tampon plafonne qui coupe la fin, la ou vit
      // justement l evenement de resultat.
      const essential = makeEssentialCapture(input.provider);
      const run = await runCli(cli, args, {
        cwd,
        timeoutMs,
        env,
        stdin: input.task,
        onStdoutLine: (line) => {
          liveRecorder(line);
          essential.onLine(line);
        },
      });

      if (run.timedOut) {
        await safeRecord(
          ctx,
          input,
          cliVersion,
          null,
          run.durationMs,
          run.exitCode,
          null,
          model,
          effort,
        );
        throw new Error(
          `cli_timeout: the ${input.provider} run exceeded ${String(timeoutMs / 1000)}s and was ` +
            `killed (with its process tree). Partial stdout: ${run.stdout.slice(0, 500)}`,
        );
      }

      // Parse fail-loud — the human-readable stream is never scraped, and an
      // unparseable JSON stream is an error, never a guess (invariant #4).
      let parsed;
      try {
        // La transcription essentielle d abord : elle est capturee au fil de
        // l eau, donc jamais amputee. Repli sur le tampon quand rien n a ete
        // capture (fixture, CLI qui n emet pas le flux attendu).
        const captured = essential.transcript();
        parsed = parseProviderOutput(input.provider, captured !== '' ? captured : run.stdout);
      } catch (err) {
        await safeRecord(
          ctx,
          input,
          cliVersion,
          null,
          run.durationMs,
          run.exitCode,
          null,
          model,
          effort,
        );
        if (err instanceof CliOutputError) {
          // Name OUR cause when it is ours. A truncated buffer yields exactly
          // these parse failures — "stdout is not valid JSON", "non-JSON line",
          // "stream ended without turn.completed" — and every one of them
          // blames the CLI for output we cut ourselves. The session really ran,
          // often for a quarter of an hour, and may have written files; the
          // least it deserves is an error that points at the right place.
          throw new Error(
            (run.truncatedStdout
              ? `code_task output exceeded the capture cap, so the stream could not be ` +
                `parsed — the CLI is not at fault. The session DID run and may have ` +
                `changed files; only the transcript was cut. Underlying: ${err.message}`
              : err.message) +
              ` (exit ${String(run.exitCode)}; stderr: ${run.stderr.slice(0, 400)})`,
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
        model,
        effort,
      );

      // Remember the thread so the next code_task in this job continues it.
      // Only on a run that actually produced one — a failed spawn has no
      // session, and storing an unusable id would make every later call spend a
      // `--resume` that the CLI rejects.
      if (parsed.sessionId) {
        try {
          await rememberSession(ctx.db, {
            entityId: ctx.entityId ?? null,
            agentId: ctx.agentId,
            provider: input.provider,
            key: sessionKey,
            sessionId: parsed.sessionId,
          });
        } catch (err) {
          // Continuity is an optimisation; losing it must never fail a run that
          // already succeeded. Logged rather than swallowed (invariant #4): the
          // symptom otherwise is "every call starts cold" with no explanation.
          console.warn('[code_task] could not persist the CLI session for resume:', err);
        }
      }

      // Le QUATRIEME cas, trouve par la review : une troncature dont le prefixe
      // reste analysable. codex peut avoir emis `turn.completed` AVANT que le
      // plafond tombe — l analyse reussit alors, et le tour repart comme s il
      // etait complet alors qu il manque la fin de la transcription.
      //
      // L analyse a REUSSI, donc echouer serait disproportionne : le resultat
      // est reel. Mais le taire ferait exactement ce que ma spec reprochait a
      // tort au code d origine — laisser passer un tour ampute pour un tour
      // complet.
      if (run.truncatedStdout) {
        console.warn(
          `[code_task] stdout a atteint le plafond mais s est quand meme analyse ` +
            `(job=${ctx.jobId}) — le resultat est reel, la transcription est incomplete`,
        );
      }

      return {
        provider: input.provider,
        mode,
        source: 'subscription' as const,
        cliVersion,
        requestedModel: model ?? null,
        requestedEffort: effort ?? null,
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
  parsed: Pick<NormalizedCliResult, 'costUsd' | 'usage' | 'modelUsage'> | null,
  durationMs: number,
  exitCode: number | null,
  sessionId: string | null = null,
  model: string | undefined = undefined,
  effort: string | undefined = undefined,
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
      model: model ?? null,
      effort: effort ?? null,
      costUsd: parsed?.costUsd ?? null,
      inputTokens: parsed?.usage?.inputTokens ?? null,
      outputTokens: parsed?.usage?.outputTokens ?? null,
      cachedTokens: parsed?.usage?.cachedTokens ?? null,
      cacheCreationTokens: parsed?.usage?.cacheCreationTokens ?? null,
      modelUsage: parsed?.modelUsage ?? null,
      durationMs,
      cliVersion,
      exitCode,
    });
  } catch (err) {
    console.error('[code_task] cli_runs audit insert failed:', err);
  }
}

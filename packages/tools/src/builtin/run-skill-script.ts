// builtin/run-skill-script.ts — execute a bundled script of an INSTALLED +
// AUTHORIZED community skill (Hermes-style: e.g. creative-comfyui's run_workflow.py).
//
// WHY a dedicated tool: Hermes-style skills ship tested scripts that do the real
// work (workflow submission, polling, retrieval). Letting the agent INVOKE a
// proven script is far more reliable than making the LLM re-derive that logic
// inline every turn (the cause of endless thrashing). This is the execution leg
// of "open Nodal to community skills with scripts".
//
// SECURITY — defense in depth, four independent gates:
//   1. SCOPE: the script must resolve INSIDE the skill's install store dir
//      (realpath + prefix guard, the SAME proven boundary as skill_file_read).
//      No arbitrary paths, no `..` escape, no symlink escape.
//   2. AUTHORIZATION: the agent must (a) hold the skill AND (b) the owner must
//      have flipped scripts_authorized for THIS agent × skill
//      (ctx.scriptAuthorizedSkillSlugs). Default off — scripts never run until
//      the owner explicitly opts in, per skill, per agent.
//   3. APPROVAL: defaultApproval 'require_approval' — every run suspends for a
//      human unless an explicit auto_approve ("Yolo") rule exists. Same posture
//      as run_command.
//   4. NO SHELL: the interpreter is spawned with an ARG ARRAY (shell:false), so
//      arguments can never be shell-injected — stricter than run_command.

import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types';
import { resolveSkillRoot, resolveWithinSkill } from './skill-ops/skill-files';

// ─── Limits ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 1800;
/** Per-stream capture cap (chars). We keep draining past this, but stop storing. */
const MAX_OUTPUT_CHARS = 100_000;

/**
 * Resolve the interpreter for a script by extension. Only these types may run.
 * Returns null for anything else (the agent gets `unsupported_script_type`).
 */
function interpreterFor(scriptPath: string): string | null {
  const lower = scriptPath.toLowerCase();
  const isWin = process.platform === 'win32';
  if (lower.endsWith('.py')) return isWin ? 'python' : 'python3';
  if (lower.endsWith('.sh')) return 'bash';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'node';
  return null;
}

// ─── Schema ─────────────────────────────────────────────────────────────────

const runSkillScriptSchema = z.object({
  skill: z
    .string()
    .min(1)
    .describe(
      "Slug of an installed skill you hold and are authorized to run scripts for (e.g. 'comfyui').",
    ),
  script: z
    .string()
    .min(1)
    .max(1000)
    .describe(
      "Path to the bundled script, relative to the skill folder (e.g. 'scripts/run_workflow.py'). " +
        'Discover available scripts with skill_file_list. Only .py / .sh / .js are runnable.',
    ),
  args: z
    .array(z.string().max(8000))
    .max(100)
    .optional()
    .describe(
      'Arguments passed to the script VERBATIM — not shell-interpreted, so they are injection-safe. ' +
        'E.g. ["--workflow", "workflows/sdxl_txt2img.json", "--prompt", "a cat", "--server", "http://127.0.0.1:8188"].',
    ),
  timeout_seconds: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_SECONDS)
    .optional()
    .describe(
      `Optional timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}). ` +
        'On timeout the script and its child processes are killed.',
    ),
});

export type RunSkillScriptInput = z.infer<typeof runSkillScriptSchema>;

export interface RunSkillScriptOutput {
  /** Process exit code, or null if killed (timeout) or failed to spawn. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the script was killed for exceeding the timeout. */
  timedOut: boolean;
  /** True when stdout or stderr hit the capture cap and was truncated. */
  truncated: boolean;
  /** The interpreter that was used (python3 / bash / node). */
  interpreter: string;
  /** The script path that ran (echoed back). */
  script: string;
}

/** Thrown when the owner has not authorized this skill's scripts for this agent. */
class ScriptsNotAuthorizedError extends Error {
  constructor(skill: string) {
    super(
      `scripts_not_authorized: running scripts for skill "${skill}" is not enabled for this agent. ` +
        'The workspace owner must turn on "Allow scripts" for this agent × skill in Skills settings. ' +
        'Do NOT retry — ask the user to enable it.',
    );
    this.name = 'scripts_not_authorized';
  }
}

// ─── Tool ───────────────────────────────────────────────────────────────────

export const runSkillScriptTool: ToolDefinition<typeof runSkillScriptSchema, RunSkillScriptOutput> =
  {
    name: 'run_skill_script',
    description:
      "Execute a script that ships with one of your installed skills (e.g. a ComfyUI skill's " +
      "run_workflow.py). Use this to run the skill's real automation instead of re-implementing " +
      'its logic inline. Pass the script path relative to the skill folder (find it with ' +
      'skill_file_list) and any arguments as an array. The script runs from the skill folder, so ' +
      'its bundled files (workflows/, references/) are reachable by relative path. Returns stdout, ' +
      'stderr and the exit code — read the stdout (often JSON) for the result, e.g. an output ' +
      'filename to deliver with send_image. By DEFAULT every run requires human approval; the user ' +
      'can enable auto-run ("Yolo") per agent. A non-zero exit code is returned to you (not an error) ' +
      '— read stderr and adapt. Only runs scripts of a skill the owner has authorized for you; ' +
      'if it returns scripts_not_authorized, ask the user to enable it rather than retrying.',
    inputSchema: runSkillScriptSchema,
    riskLevel: 'destructive',
    defaultApproval: 'require_approval',
    execute: async (
      input: RunSkillScriptInput,
      ctx: ToolContext,
    ): Promise<RunSkillScriptOutput> => {
      // GATE 2 — authorization: owner opted THIS skill's scripts in for THIS agent.
      const authorized = ctx.scriptAuthorizedSkillSlugs ?? [];
      if (!authorized.includes(input.skill)) {
        throw new ScriptsNotAuthorizedError(input.skill);
      }

      // GATE 1 — scope: resolve the skill root (verifies assigned + installed) and
      // the script path strictly within it (realpath + prefix guard).
      const realRoot = await resolveSkillRoot(ctx, input.skill);
      const scriptAbs = await resolveWithinSkill(realRoot, input.script);

      const interpreter = interpreterFor(scriptAbs);
      if (!interpreter) {
        const err = new Error(
          `unsupported_script_type: only .py, .sh and .js scripts can be run (got "${input.script}").`,
        );
        err.name = 'unsupported_script_type';
        throw err;
      }

      const timeoutMs = (input.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
      // GATE 4 — no shell: interpreter + [script, ...args] as an arg array.
      return runScript(
        interpreter,
        [scriptAbs, ...(input.args ?? [])],
        realRoot,
        timeoutMs,
        input.script,
      );
    },
  };

// ─── Process execution (no shell, timeout + tree-kill, capped output) ─────────

function runScript(
  interpreter: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
  scriptLabel: string,
): Promise<RunSkillScriptOutput> {
  return new Promise<RunSkillScriptOutput>((resolve) => {
    const isWindows = process.platform === 'win32';

    // shell:false — no shell interpolation; argv is passed literally. detached on
    // Unix makes the child a process-group leader so the WHOLE tree dies on
    // timeout (negative pid). On Windows we use taskkill /T instead.
    const child = spawn(interpreter, argv, {
      cwd,
      shell: false,
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
          try {
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
          } catch {
            /* taskkill unavailable — fall through */
          }
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* already dead */
          }
        }
      }
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
      resolve({ exitCode, stdout, stderr, timedOut, truncated, interpreter, script: scriptLabel });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      graceTimer = setTimeout(() => finish(null), 3000);
    }, timeoutMs);

    child.on('error', (err: Error) => {
      // spawn failure (interpreter missing, cwd vanished, …). Return as a failed
      // RESULT so the agent gets a tool_result it can react to.
      stderr = append(stderr, Buffer.from(`${stderr ? '\n' : ''}spawn_error: ${err.message}`));
      finish(null);
    });
    child.on('close', (code: number | null) => finish(code));
  });
}

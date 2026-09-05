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

import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types';
import { resolveSkillRoot, resolveWithinSkill } from './skill-ops/skill-files';
import { buildChildEnv } from './child-env';
import { SHARED_WORKSPACE_LABEL } from './file-ops/workspace';
import { runShellCommand } from './shell-engine';

// ─── Limits ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 1800;
// Le plafond de capture vit dans le moteur partagé (shell-engine.ts).

/**
 * Find a Python that actually RUNS, probing candidates with `--version`.
 * On Windows, `python` on PATH is often the Microsoft Store STUB, which exits
 * 9009 with "Python was not found" — a bare name pick bricked every .py skill
 * script (live incident 2026-07-20: two image jobs burned 25+ recovery tool
 * calls each after exit 9009). The stub fails the probe, so it can never be
 * selected. Result cached for the process lifetime; null = none available.
 */
let cachedPython: string | null | undefined;
export function resolvePythonInterpreter(): string | null {
  if (cachedPython !== undefined) return cachedPython;
  const candidates =
    process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ['--version'], { windowsHide: true, timeout: 5000 });
      if (probe.status === 0) {
        cachedPython = candidate;
        return candidate;
      }
    } catch {
      /* candidate unusable — try the next */
    }
  }
  cachedPython = null;
  return null;
}

/** Test-only: forget the probed interpreter so tests can re-probe. */
export function _resetPythonInterpreterCacheForTests(): void {
  cachedPython = undefined;
}

/**
 * Resolve the interpreter for a script by extension. Only these types may run.
 * Returns null for anything else (the agent gets `unsupported_script_type`);
 * 'python-missing' when the script is Python but no working interpreter exists
 * (fail loud with an actionable error instead of the stub's cryptic 9009).
 */
function interpreterFor(scriptPath: string): string | 'python-missing' | null {
  const lower = scriptPath.toLowerCase();
  if (lower.endsWith('.py')) return resolvePythonInterpreter() ?? 'python-missing';
  if (lower.endsWith('.sh')) return 'bash';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'node';
  return null;
}

// ─── Schema ─────────────────────────────────────────────────────────────────

const runSkillScriptSchema = z.object({
  purpose: z
    .string()
    .min(1)
    .max(400)
    .describe(
      "REQUIRED. A short plain-language explanation, IN THE USER'S LANGUAGE, of what running " +
        'this script does and why. Shown FIRST on the approval prompt so the user can decide ' +
        'without reading the raw script call.',
    ),
  impact: z
    .string()
    .max(400)
    .optional()
    .describe(
      'OPTIONAL. The potential NEGATIVE or destructive impact, if any (writes files, installs ' +
        'software, network/GPU use, spends money, long-running). Shown as a ⚠️ warning. OMIT when ' +
        'the script is harmless / read-only.',
    ),
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
  /**
   * New files the script created INSIDE the skill bundle (relative paths).
   * The bundle ships the skill's code — generation artifacts do not belong
   * there. Present (with `warning`) only when such writes were detected.
   */
  bundleWrites?: string[];
  /** Loud, actionable notice accompanying `bundleWrites`. */
  warning?: string;
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
      'filename to deliver with send_image. When the script produces artifacts (images, exports), ' +
      'point its output argument at the SHARED WORKSPACE — its absolute path is exposed to the ' +
      'script as the NODAL_SHARED_WORKSPACE environment variable — never at the skill folder ' +
      '(a `warning` comes back if bundle writes are detected). By DEFAULT every run requires human approval; the user ' +
      'can enable auto-run ("Yolo") per agent. A non-zero exit code is returned to you (not an error) ' +
      '— read stderr and adapt. Only runs scripts of a skill the owner has authorized for you; ' +
      'if it returns scripts_not_authorized, ask the user to enable it rather than retrying.',
    inputSchema: runSkillScriptSchema,
    riskLevel: 'destructive',
    mutatesWorkspace: true,
    defaultApproval: 'require_approval',
    // TOUS les dossiers attachés, jamais le bundle de la skill. Le contrat du
    // tool est que les artefacts vont dans NODAL_SHARED_WORKSPACE, et la
    // veille `listBundleFiles` plus bas CONSTATE après coup qu'on ne contraint
    // pas où un script écrit — le périmètre déclaré ici doit donc être celui
    // qu'un script peut réellement atteindre.
    resolveMutationTargets: async (_input: RunSkillScriptInput, ctx: ToolContext) =>
      (ctx.workspaces ?? []).map((w) => ({
        kind: 'dir' as const,
        path: w.path,
        deliverableType: 'code_project' as const,
      })),
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
      if (interpreter === 'python-missing') {
        // Fail LOUD with the real problem — before this guard the Windows
        // Store stub answered instead of Python (cryptic exit 9009) and agents
        // burned dozens of tool calls probing for a working interpreter.
        const err = new Error(
          'python_not_found: no working Python interpreter on PATH (tried py, python, python3). ' +
            'Install Python or fix the PATH of the Nodal process, then retry. ' +
            'Do NOT try to locate an interpreter yourself with run_command.',
        );
        err.name = 'python_not_found';
        throw err;
      }

      const timeoutMs = (input.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

      // Shared workspace path — handed to the script via NODAL_SHARED_WORKSPACE
      // so it can write its artifacts there (e.g. --output-dir) instead of
      // polluting the bundle (cwd). Absent when the agent has no shared workspace.
      const sharedWorkspace = (ctx.workspaces ?? []).find(
        (w) => w.label === SHARED_WORKSPACE_LABEL,
      )?.path;

      // Bundle-pollution watch: snapshot the bundle's file set before/after.
      // The bundle is the skill's shipped code — artifacts belong in the shared
      // workspace. We do NOT move anything (the artifact may be the deliverable);
      // we report loudly so the agent relocates it and fixes its next call.
      const before = await listBundleFiles(realRoot);

      // GATE 4 — no shell: interpreter + [script, ...args] as an arg array.
      const result = await runScript(
        interpreter,
        [scriptAbs, ...(input.args ?? [])],
        realRoot,
        timeoutMs,
        input.script,
        sharedWorkspace ? { NODAL_SHARED_WORKSPACE: sharedWorkspace } : undefined,
      );

      const after = await listBundleFiles(realRoot);
      const bundleWrites = [...after].filter((f) => !before.has(f)).sort();
      if (bundleWrites.length > 0) {
        result.bundleWrites = bundleWrites.slice(0, 20);
        result.warning =
          `bundle_pollution: this run created ${bundleWrites.length} file(s) inside the "${input.skill}" ` +
          `skill bundle (its shipped code). Artifacts belong in the shared workspace` +
          (sharedWorkspace
            ? ` (${sharedWorkspace} — also exposed to scripts as $NODAL_SHARED_WORKSPACE)`
            : '') +
          `. Move the file(s) there now, and on the next run point the script's output ` +
          `argument at the shared workspace instead.`;
      }
      return result;
    },
  };

/**
 * Recursive relative-path file set of the skill bundle. Bounded (a bundle is
 * dozens of files; the cap only guards a pathological runaway). Compiled-cache
 * noise (__pycache__) is ignored — Python creates it on every import.
 */
async function listBundleFiles(root: string, cap = 5000): Promise<Set<string>> {
  const files = new Set<string>();
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (files.size >= cap) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.size >= cap) return;
      if (e.name === '__pycache__' || e.name.endsWith('.pyc')) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(join(dir, e.name), childRel);
      } else {
        files.add(childRel);
      }
    }
  };
  await walk(root, '');
  return files;
}

// ─── Process execution — le moteur partagé (shell-engine.ts) ──────────────────
//
// shell:false : argv littéral, aucune interpolation. Ce qui reste ici est la
// forme du tool_result (interpreter, script) et le contrat historique
// `exitCode: null` pour « tué ou pas lancé ».

async function runScript(
  interpreter: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
  scriptLabel: string,
  envExtras?: Record<string, string>,
): Promise<RunSkillScriptOutput> {
  const run = await runShellCommand({
    target: { file: interpreter, args: argv },
    cwd,
    timeoutMs,
    // Scrubbed env, NOT process.env — a skill script must not be able to read
    // DATABASE_URL/WORKER_SECRET/LLM keys via os.environ / process.env.
    env: buildChildEnv(process.env, envExtras),
    keep: 'head',
  });
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
    interpreter,
    script: scriptLabel,
  };
}

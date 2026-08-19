// builtin/code-task/process.ts — CLI resolution + safe spawn for code_task.
//
// Spawn contract (étape-A/A-bis findings baked in):
//   - argv strict, shell:false — the LLM-written task NEVER traverses a shell
//     string. On Windows a `.cmd`/`.bat` npm shim cannot be spawned directly
//     (Node EINVAL), so we use the dsh batch-shim pattern: cmd.exe re-parses a
//     QUOTED ENV VARIABLE holding the executable path; the args tail stays
//     argv (dsh subagent-claude-code/src/process.ts:51-74).
//   - stdio: ['ignore', 'pipe', 'pipe'] — with a piped stdin, claude stalls
//     3 s and codex waits FOREVER (étape-A finding 1).
//   - tree-kill on timeout: taskkill /T /F on Windows, negative-pid SIGKILL
//     elsewhere (same as run_command / run_skill_script).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';

const WINDOWS_BATCH_EXECUTABLE_ENV = 'NODAL_CODE_TASK_EXECUTABLE';

/** Per-stream capture caps. stdout carries the CLI's JSON — generous cap. */
const MAX_STDOUT_CHARS = 400_000;
const MAX_STDERR_CHARS = 50_000;

export interface ResolvedCli {
  /** Absolute path to the executable. */
  path: string;
  /** True for .cmd/.bat (needs the cmd.exe batch shim on Windows). */
  isBatch: boolean;
}

/**
 * Resolve a CLI name (`claude`, `codex`) to an absolute executable path by
 * scanning PATH — spawn(shell:false) does no PATH+PATHEXT resolution for
 * .cmd shims on Windows, and we need the extension to pick the spawn shape.
 * Returns null when not found (caller fails loud with an install hint).
 */
export function resolveCliPath(
  bin: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): ResolvedCli | null {
  const pathVar = env['PATH'] ?? env['Path'] ?? '';
  const dirs = pathVar.split(delimiter).filter((d) => d !== '');
  const candidates = platform === 'win32' ? [`${bin}.exe`, `${bin}.cmd`, `${bin}.bat`] : [bin];
  for (const dir of dirs) {
    for (const name of candidates) {
      const full = join(dir, name);
      if (existsSync(full)) {
        const ext = extname(full).toLowerCase();
        return { path: full, isBatch: ext === '.cmd' || ext === '.bat' };
      }
    }
  }
  return null;
}

/**
 * Build the final argv for a resolved CLI + args tail.
 * Exported separately so the shim shape is unit-testable without spawning.
 */
export function buildSpawnArgv(
  cli: ResolvedCli,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { argv: string[]; envExtra: Record<string, string> } {
  if (platform === 'win32' && cli.isBatch) {
    return {
      argv: ['cmd.exe', '/d', '/v:off', '/s', '/c', `%${WINDOWS_BATCH_EXECUTABLE_ENV}%`, ...args],
      envExtra: { [WINDOWS_BATCH_EXECUTABLE_ENV]: `"${cli.path}"` },
    };
  }
  return { argv: [cli.path, ...args], envExtra: {} };
}

export interface RunCliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

/**
 * Spawn a resolved CLI with an args tail and wait for completion.
 * Never throws for process-level failures — spawn errors land in stderr with
 * exitCode null, so the caller can build one loud, complete error message.
 */
export function runCli(
  cli: ResolvedCli,
  args: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    env: Record<string, string | undefined>;
  },
): Promise<RunCliResult> {
  const { argv, envExtra } = buildSpawnArgv(cli, args);
  const [command, ...rest] = argv;
  const isWindows = process.platform === 'win32';
  const startedAt = Date.now();

  return new Promise<RunCliResult>((resolve) => {
    const child = spawn(command as string, rest, {
      cwd: opts.cwd,
      shell: false,
      detached: !isWindows,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...opts.env, ...envExtra } as unknown as NodeJS.ProcessEnv,
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (existing: string, chunk: Buffer, cap: number): string => {
      if (existing.length >= cap) {
        truncated = true;
        return existing;
      }
      const text = chunk.toString('utf8');
      const room = cap - existing.length;
      if (text.length <= room) return existing + text;
      truncated = true;
      return existing + text.slice(0, room);
    };
    // Keep draining past the cap so the child never blocks on a full pipe.
    child.stdout?.on('data', (c: Buffer) => {
      stdout = append(stdout, c, MAX_STDOUT_CHARS);
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr = append(stderr, c, MAX_STDERR_CHARS);
    });

    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const killTree = (): void => {
      if (child.pid) {
        if (isWindows) {
          try {
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
          } catch {
            /* taskkill unavailable — fall through to child.kill below */
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
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        truncated,
        durationMs: Date.now() - startedAt,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // Resolve even if 'close' never fires (a stubborn grandchild can hold a
      // pipe open after the tree-kill).
      graceTimer = setTimeout(() => finish(null), 3000);
    }, opts.timeoutMs);

    child.on('error', (err: Error) => {
      stderr = append(
        stderr,
        Buffer.from(`${stderr ? '\n' : ''}spawn_error: ${err.message}`),
        MAX_STDERR_CHARS,
      );
      finish(null);
    });
    child.on('close', (code: number | null) => finish(code));
  });
}

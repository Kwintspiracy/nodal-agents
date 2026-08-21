// builtin/code-task/process.ts — CLI resolution + safe spawn for code_task.
//
// Spawn contract (étape-A/A-bis findings baked in):
//   - the LLM-written task goes via STDIN (write + close — both CLIs read the
//     prompt natively: `claude -p` stdin / `codex exec -`, proven live
//     2026-08-20), NEVER via argv: on Windows a `.cmd`/`.bat` npm shim cannot
//     be spawned directly (Node EINVAL), so argv traverses `cmd.exe /c` (the
//     dsh batch-shim pattern: a QUOTED ENV VARIABLE holds the executable
//     path) — and cmd.exe RE-PARSES that line, so free text in argv is
//     command injection (`x&whoami`). Remaining argv is validated against
//     CMD_UNSAFE_CHARS — fail loud, never escape.
//   - stdin stays 'ignore' when no prompt is passed — a piped-but-unwritten
//     stdin stalls claude 3 s and hangs codex FOREVER (étape-A finding 1).
//   - tree-kill on timeout: taskkill /T /F on Windows, negative-pid SIGKILL
//     elsewhere (same as run_command / run_skill_script).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

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
 * cmd.exe RE-PARSES the tail after `/c` — any of these characters inside an
 * argv element can break out of its argument position (Node only quotes args
 * containing whitespace, so `x&whoami` reaches cmd.exe bare — the BatBadBut
 * class). Escaping cmd.exe reliably is a known-hard problem, so we don't:
 * arbitrary text (the prompt) goes via STDIN and never enters argv, and the
 * remaining args (flags, model/effort ids, paths) are validated here — an
 * offender is a loud error (invariant #4), never silently mangled.
 * `"` stays allowed: codex's TOML `-c key="value"` overrides need it, and
 * with the metacharacters below banned a stray quote cannot be weaponized.
 */
const CMD_UNSAFE_CHARS = /[&|<>^%\r\n]/;

/**
 * Build the final argv for a resolved CLI + args tail.
 * Exported separately so the shim shape is unit-testable without spawning.
 * Throws on args that cmd.exe could reinterpret (batch path only).
 */
export function buildSpawnArgv(
  cli: ResolvedCli,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { argv: string[]; envExtra: Record<string, string> } {
  if (platform === 'win32' && cli.isBatch) {
    for (const arg of args) {
      if (CMD_UNSAFE_CHARS.test(arg)) {
        throw new Error(
          `cmd_unsafe_argument: refusing to pass ${JSON.stringify(arg.slice(0, 80))} through the ` +
            `Windows .cmd shim — it contains a character cmd.exe could reinterpret (&|<>^% or a ` +
            `newline). Free-form text must be passed via stdin, never argv.`,
        );
      }
    }
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
    /**
     * Free-form input (the task prompt) written to the child's stdin then
     * closed. This is the ONLY safe channel for arbitrary text on the Windows
     * .cmd shim path (see CMD_UNSAFE_CHARS) — and both CLIs read it natively
     * (`claude -p` stdin, `codex exec -`). Absent ⇒ stdin stays 'ignore'
     * (a piped-but-unwritten stdin stalls claude 3 s and hangs codex —
     * étape-A finding 1).
     */
    stdin?: string;
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
      stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: { ...opts.env, ...envExtra } as unknown as NodeJS.ProcessEnv,
    });

    if (opts.stdin !== undefined && child.stdin) {
      // EPIPE when the child dies before reading — not our failure to report.
      child.stdin.on('error', () => {});
      child.stdin.end(opts.stdin);
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    // One decoder per stream: chunk boundaries do NOT align with UTF-8
    // character boundaries, so per-chunk toString() corrupts multi-byte
    // characters (é → �) split across chunks.
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');

    const append = (existing: string, text: string, cap: number): string => {
      if (existing.length >= cap) {
        truncated = true;
        return existing;
      }
      const room = cap - existing.length;
      if (text.length <= room) return existing + text;
      truncated = true;
      return existing + text.slice(0, room);
    };
    // Keep draining past the cap so the child never blocks on a full pipe.
    child.stdout?.on('data', (c: Buffer) => {
      stdout = append(stdout, outDecoder.write(c), MAX_STDOUT_CHARS);
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr = append(stderr, errDecoder.write(c), MAX_STDERR_CHARS);
    });

    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const killTree = (): void => {
      if (child.pid) {
        if (isWindows) {
          // taskkill /T resolves the tree from a live snapshot — killing the
          // parent FIRST orphans the children and taskkill then finds nothing.
          // So: taskkill alone (it kills the root too), child.kill only as
          // the fallback once taskkill failed to start or exited non-zero.
          try {
            const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
              windowsHide: true,
            });
            tk.on('close', (code) => {
              if (code !== 0) {
                try {
                  child.kill('SIGKILL');
                } catch {
                  /* already dead */
                }
              }
            });
            tk.on('error', () => {
              try {
                child.kill('SIGKILL');
              } catch {
                /* already dead */
              }
            });
            return;
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
      stderr = append(stderr, `${stderr ? '\n' : ''}spawn_error: ${err.message}`, MAX_STDERR_CHARS);
      finish(null);
    });
    child.on('close', (code: number | null) => finish(code));
  });
}

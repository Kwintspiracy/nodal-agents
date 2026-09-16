// run-command.test.ts — the run_command builtin, exercised against REAL spawned
// processes (asserts captured stdout/stderr/exit, timeout-kill, cwd lock, output
// cap) plus its security guards (workspace fail-loud, cwd boundary). Uses
// `node -e` for cross-platform portability (node is always present in the test env).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommandTool } from '../builtin/run-command';
import { WorkspaceError } from '../builtin/file-ops/workspace';
import { registerBuiltins, ALWAYS_ON_TOOLS } from '../builtin/index';
import { createToolRegistry } from '../registry';
import { computeToolWhitelist } from '../whitelist';
import type { ToolContext, ToolDefinition } from '../types';
import { presentToolResult } from '../cards';
import type { z } from 'zod';

let workspaceDir: string;

beforeAll(async () => {
  // realpath so the cwd echoed by the child compares equal (macOS /var → /private/var).
  workspaceDir = await realpath(await mkdtemp(join(tmpdir(), 'nodal-runcmd-')));
});

afterAll(async () => {
  // Best-effort: on Windows a just-killed process can briefly hold the dir
  // handle, so retry a few times rather than failing the suite on EBUSY.
  for (let i = 0; i < 5; i++) {
    try {
      await rm(workspaceDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});

// run_command.execute only reads ctx.workspaces — db is never touched.
function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    jobId: 'job-1',
    agentId: 'agent-1',
    entityId: 'entity-1',
    db: undefined as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces: [{ label: 'ws', path: workspaceDir }],
    ...overrides,
  };
}

describe('run_command builtin @cap:executer-une-commande/moteur', () => {
  it('captures stdout and exit code 0 from a real command', async () => {
    const out = await runCommandTool.execute(
      { purpose: 'run test command', command: `node -e "process.stdout.write('hello-stdout')"` },
      ctx(),
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('hello-stdout');
    expect(out.timedOut).toBe(false);
    expect(out.truncated).toBe(false);
  });

  it('captures stderr and a non-zero exit code (returned, not thrown)', async () => {
    const out = await runCommandTool.execute(
      {
        purpose: 'run test command',
        command: `node -e "process.stderr.write('boom'); process.exit(3)"`,
      },
      ctx(),
    );
    expect(out.exitCode).toBe(3);
    expect(out.stderr).toContain('boom');
  });

  it('runs a compound command (&&) as a single call', async () => {
    const out = await runCommandTool.execute(
      {
        purpose: 'run test command',
        command: `node -e "process.stdout.write('a')" && node -e "process.stdout.write('b')"`,
      },
      ctx(),
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('a');
    expect(out.stdout).toContain('b');
  });

  it('runs in the agent workspace as its working directory', async () => {
    const out = await runCommandTool.execute(
      { purpose: 'run test command', command: `node -e "process.stdout.write(process.cwd())"` },
      ctx(),
    );
    expect(await realpath(out.stdout.trim())).toBe(workspaceDir);
    expect(out.cwd).toBe(workspaceDir);
  });

  it('resolves an explicit cwd inside the workspace', async () => {
    // Workspace root is fine; the point is the boundary-checked resolve runs.
    const out = await runCommandTool.execute(
      {
        purpose: 'run test command',
        command: `node -e "process.stdout.write(process.cwd())"`,
        cwd: '.',
      },
      ctx(),
    );
    expect(out.exitCode).toBe(0);
    expect(await realpath(out.stdout.trim())).toBe(workspaceDir);
  });

  it('times out and kills a long-running command (with its children)', async () => {
    // Le processus écrit son pid AVANT de dormir : c'est lui, le petit-enfant
    // de cmd.exe / sh, qu'on veut voir mort. Le test précédent n'assertait que
    // `timedOut` et passait avec le tree-kill cassé (sonde du 03/09 : le
    // petit-enfant survivait 3 fois sur 3).
    const out = await runCommandTool.execute(
      {
        purpose: 'run test command',
        command: `node -e "process.stdout.write(String(process.pid)); setTimeout(()=>{}, 60000)"`,
        timeout_seconds: 1,
      },
      ctx(),
    );
    expect(out.timedOut).toBe(true);
    expect(out.exitCode).not.toBe(0); // killed → no clean exit
    const pid = Number(out.stdout.trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* déjà mort */
      }
    }
    expect(alive).toBe(false);
  });

  it('caps very large output (truncated=true, ≤ cap)', async () => {
    const out = await runCommandTool.execute(
      {
        purpose: 'run test command',
        command: `node -e "process.stdout.write('x'.repeat(300000))"`,
      },
      ctx(),
    );
    expect(out.truncated).toBe(true);
    expect(out.stdout.length).toBeLessThanOrEqual(100_000);
  });

  it('fails loud when the agent has no workspace configured', async () => {
    await expect(
      runCommandTool.execute(
        { purpose: 'run test command', command: 'echo hi' },
        ctx({ workspaces: [] }),
      ),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('rejects a cwd that escapes the workspace (path_traversal_blocked)', async () => {
    await expect(
      runCommandTool.execute(
        { purpose: 'run test command', command: 'echo hi', cwd: '../../somewhere-else' },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'path_traversal_blocked' });
  });
});

// ─── Gating (security): run_command must NOT be available to every agent ──────
// run_command is unlocked ONLY by the "command-execution" skill (requiredBuiltins).
// If it ever leaked into ALWAYS_ON_TOOLS, every agent could run shell commands —
// this block fails loud on that regression.

describe('run_command gating @cap:approuver-une-action/moteur', () => {
  it('is registered but NOT always-on', () => {
    expect((ALWAYS_ON_TOOLS as readonly string[]).includes('run_command')).toBe(false);
    const reg = createToolRegistry();
    registerBuiltins(reg);
    expect(reg.get('run_command')).toBeDefined(); // registered, available to gate
  });

  it('reaches an agent ONLY when run_command is in the requiredBuiltins union', () => {
    const reg = createToolRegistry();
    registerBuiltins(reg);

    // Agent WITHOUT the command-execution skill: always-on only.
    const without = computeToolWhitelist(
      { agentId: 'no-skill', configuredTools: [], alwaysOn: [...ALWAYS_ON_TOOLS] },
      reg,
    );
    expect(without.map((t) => t.name)).not.toContain('run_command');

    // Agent WITH the skill: the runner unions its requiredBuiltins into alwaysOn.
    const withSkill = computeToolWhitelist(
      { agentId: 'has-skill', configuredTools: [], alwaysOn: [...ALWAYS_ON_TOOLS, 'run_command'] },
      reg,
    );
    expect(withSkill.map((t) => t.name)).toContain('run_command');
  });
});

// ─── P1 : la carte terminal, sur une vraie commande ──────────────────────────

describe('présentation (P1) — run_command', () => {
  it('une commande réelle remplit la carte terminal : commande, code, fin de sortie, cwd', async () => {
    const input = {
      purpose: 'run test command',
      command: `node -e "process.stdout.write('hello-card')"`,
    };
    const out = await runCommandTool.execute(input, ctx());
    const p = presentToolResult(
      runCommandTool as unknown as ToolDefinition<z.ZodTypeAny, unknown>,
      input,
      out,
    );
    expect(p).toEqual({
      card: 'terminal',
      command: input.command,
      exitCode: 0,
      timedOut: false,
      stdoutTail: 'hello-card',
      stdoutTruncated: false,
      stderrTail: '',
      stderrTruncated: false,
      cwd: out.cwd,
    });
  });
});

// ─── Per-agent command allowlist ────────────────────────────────────────────
// The pure matcher is proven in builtin/command-allowlist.test.ts. What is
// proven HERE is that run_command actually consults it, and that a refused
// command never reaches a process — the file the command would have written
// does not exist afterwards.

describe('run_command — per-agent command allowlist @cap:executer-une-commande/moteur', () => {
  it('runs a command that is on the allowlist', async () => {
    const out = await runCommandTool.execute(
      { purpose: 'allowed', command: `node -e "process.stdout.write('ok-allowed')"` },
      ctx({ commandAllowlist: ['node', 'npx vitest'] }),
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('ok-allowed');
  });

  it('refuses a command that is not on the allowlist, and nothing runs', async () => {
    const marker = join(workspaceDir, 'should-not-exist.txt');
    await expect(
      runCommandTool.execute(
        {
          purpose: 'refused',
          command: `npx rimraf --version && node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')"`,
        },
        ctx({ commandAllowlist: ['node'] }),
      ),
    ).rejects.toThrow(/not on this agent's command allowlist/);
    const { existsSync } = await import('node:fs');
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses the unlisted half of a compound command that starts with a listed one', async () => {
    const marker = join(workspaceDir, 'should-not-exist-2.txt');
    await expect(
      runCommandTool.execute(
        {
          purpose: 'refused compound',
          command: `node -e "1" && npx rimraf ${JSON.stringify(marker)}`,
        },
        ctx({ commandAllowlist: ['node'] }),
      ),
    ).rejects.toThrow(/not on this agent's command allowlist/);
  });

  it('leaves behaviour unchanged when no allowlist is configured', async () => {
    const out = await runCommandTool.execute(
      { purpose: 'no allowlist', command: `node -e "process.stdout.write('no-list')"` },
      ctx(),
    );
    expect(out.stdout).toContain('no-list');
  });
});

// ─── With a list: NO SHELL AT ALL ───────────────────────────────────────────
// Five review passes found five holes in one scanner that tried to read a
// command the way cmd.exe would. The sixth was always coming. So when a list
// is set the command no longer reaches a shell: it is read as one program and
// its arguments, and spawned with argv literal. Everything the simple reader
// cannot understand is refused, with a message naming what to remove.

describe('run_command with a list runs NO shell @cap:executer-une-commande/moteur', () => {
  const LIST = ['node', 'npx vitest'];

  it('runs a listed program and returns its real output', async () => {
    const out = await runCommandTool.execute(
      { purpose: 'version', command: 'node -v' },
      ctx({ commandAllowlist: LIST }),
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toMatch(/^v\d+\./);
  });

  it('groups an argument with double quotes, and a single quote inside is just a character', async () => {
    const out = await runCommandTool.execute(
      { purpose: 'snippet', command: `node -e "console.log('ok-no-shell')"` },
      ctx({ commandAllowlist: LIST }),
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('ok-no-shell');
  });

  it('refuses chaining: there is no shell to chain with', async () => {
    await expect(
      runCommandTool.execute(
        { purpose: 'chain', command: 'node -v && calc' },
        ctx({ commandAllowlist: LIST }),
      ),
    ).rejects.toThrow(/not on this agent's command allowlist|cannot be read/i);
  });

  it('refuses the caret, which five passes of scanner could never read safely', async () => {
    await expect(
      runCommandTool.execute(
        { purpose: 'caret', command: `node x ^>& calc` },
        ctx({ commandAllowlist: LIST }),
      ),
    ).rejects.toThrow(/cannot be read|not on this agent/i);
  });

  it('refuses a variable, which nothing would expand anyway', async () => {
    await expect(
      runCommandTool.execute(
        { purpose: 'expansion', command: 'node x %EVIL%' },
        ctx({ commandAllowlist: LIST }),
      ),
    ).rejects.toThrow(/cannot be read|not on this agent/i);
  });

  it('names the character to remove, so the agent can rewrite its command', async () => {
    try {
      await runCommandTool.execute(
        { purpose: 'chain', command: 'node -v && calc' },
        ctx({ commandAllowlist: LIST }),
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/&/);
    }
  });

  it('runs a multi-word entry (npx vitest) through its real launcher', async () => {
    const out = await runCommandTool.execute(
      { purpose: 'vitest', command: 'npx vitest --version' },
      ctx({ commandAllowlist: ['npx vitest'] }),
    );
    // A .cmd on PATH: proven to START, whatever it then prints.
    expect(out.stdout.length + out.stderr.length).toBeGreaterThan(0);
  }, 120_000);

  it('resolves the program from the PATH, never from the working directory', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'nodal-noshell-')));
    const witness = join(dir, 'planted-ran.txt');
    const { writeFile } = await import('node:fs/promises');
    if (process.platform === 'win32') {
      await writeFile(
        join(dir, 'node.cmd'),
        `@echo off
echo planted > ${JSON.stringify(witness)}
echo i-am-planted
`,
        'utf8',
      );
    } else {
      const { chmod } = await import('node:fs/promises');
      await writeFile(
        join(dir, 'node'),
        `#!/bin/sh
echo planted > ${JSON.stringify(witness)}
`,
        'utf8',
      );
      await chmod(join(dir, 'node'), 0o755);
    }
    try {
      const out = await runCommandTool.execute(
        { purpose: 'planted', command: 'node -v' },
        ctx({ workspaces: [{ label: 'ws', path: dir }], commandAllowlist: ['node'] }),
      );
      expect(out.stdout.trim()).toMatch(/^v\d+\./);
      const { existsSync } = await import('node:fs');
      expect(existsSync(witness)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves an agent with NO list on the shell, unchanged', async () => {
    const out = await runCommandTool.execute(
      {
        purpose: 'no list',
        command: `node -e "process.stdout.write('a')" && node -e "process.stdout.write('b')"`,
      },
      ctx(),
    );
    expect(out.stdout).toContain('a');
    expect(out.stdout).toContain('b');
  });
});

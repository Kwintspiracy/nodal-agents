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
import type { ToolContext } from '../types';

let workspaceDir: string;

beforeAll(async () => {
  // realpath so the cwd echoed by the child compares equal (macOS /var → /private/var).
  workspaceDir = await realpath(await mkdtemp(join(tmpdir(), 'nodal-runcmd-')));
});

afterAll(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
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

describe('run_command builtin', () => {
  it('captures stdout and exit code 0 from a real command', async () => {
    const out = await runCommandTool.execute(
      { command: `node -e "process.stdout.write('hello-stdout')"` },
      ctx(),
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('hello-stdout');
    expect(out.timedOut).toBe(false);
    expect(out.truncated).toBe(false);
  });

  it('captures stderr and a non-zero exit code (returned, not thrown)', async () => {
    const out = await runCommandTool.execute(
      { command: `node -e "process.stderr.write('boom'); process.exit(3)"` },
      ctx(),
    );
    expect(out.exitCode).toBe(3);
    expect(out.stderr).toContain('boom');
  });

  it('runs a compound command (&&) as a single call', async () => {
    const out = await runCommandTool.execute(
      {
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
      { command: `node -e "process.stdout.write(process.cwd())"` },
      ctx(),
    );
    expect(await realpath(out.stdout.trim())).toBe(workspaceDir);
    expect(out.cwd).toBe(workspaceDir);
  });

  it('resolves an explicit cwd inside the workspace', async () => {
    // Workspace root is fine; the point is the boundary-checked resolve runs.
    const out = await runCommandTool.execute(
      { command: `node -e "process.stdout.write(process.cwd())"`, cwd: '.' },
      ctx(),
    );
    expect(out.exitCode).toBe(0);
    expect(await realpath(out.stdout.trim())).toBe(workspaceDir);
  });

  it('times out and kills a long-running command (with its children)', async () => {
    const out = await runCommandTool.execute(
      { command: `node -e "setTimeout(()=>{}, 60000)"`, timeout_seconds: 1 },
      ctx(),
    );
    expect(out.timedOut).toBe(true);
    expect(out.exitCode).not.toBe(0); // killed → no clean exit
  });

  it('caps very large output (truncated=true, ≤ cap)', async () => {
    const out = await runCommandTool.execute(
      { command: `node -e "process.stdout.write('x'.repeat(300000))"` },
      ctx(),
    );
    expect(out.truncated).toBe(true);
    expect(out.stdout.length).toBeLessThanOrEqual(100_000);
  });

  it('fails loud when the agent has no workspace configured', async () => {
    await expect(
      runCommandTool.execute({ command: 'echo hi' }, ctx({ workspaces: [] })),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('rejects a cwd that escapes the workspace (path_traversal_blocked)', async () => {
    await expect(
      runCommandTool.execute({ command: 'echo hi', cwd: '../../somewhere-else' }, ctx()),
    ).rejects.toMatchObject({ code: 'path_traversal_blocked' });
  });
});

// ─── Gating (security): run_command must NOT be available to every agent ──────
// run_command is unlocked ONLY by the "command-execution" skill (requiredBuiltins).
// If it ever leaked into ALWAYS_ON_TOOLS, every agent could run shell commands —
// this block fails loud on that regression.

describe('run_command gating', () => {
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

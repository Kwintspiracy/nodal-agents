// sandbox.test.ts — the confinement guard.
//
// Closes a real hole in the shipped 0.8.5: `code_task` told the model, in its
// own schema, that read mode means "the CLI cannot modify files or run shell
// commands". On Windows with `provider: "codex"` that was false — measured
// 2026-08-21, five reproductions, including with the exact argv this package
// builds. See sandbox.ts for the commands and outputs.
//
// These cases pin the DECISION, not the measurement: which combinations are
// refused, which are untouched, and that the refusal says enough to act on.

import { describe, it, expect } from 'vitest';
import { codexSandboxEnforced, assertSandboxEnforced } from './sandbox';

describe('codexSandboxEnforced', () => {
  it('trusts the two platforms codex actually sandboxes on', () => {
    expect(codexSandboxEnforced('linux')).toBe(true);
    expect(codexSandboxEnforced('darwin')).toBe(true);
  });

  it('does not trust Windows', () => {
    expect(codexSandboxEnforced('win32')).toBe(false);
  });

  it('does not trust a platform nobody has measured', () => {
    // The safe answer for the unknown case, not the convenient one: a platform
    // we have never tested must not inherit a guarantee by default.
    for (const p of ['freebsd', 'aix', 'sunos'] as NodeJS.Platform[]) {
      expect(codexSandboxEnforced(p), `${p} was trusted without evidence`).toBe(false);
    }
  });
});

describe('assertSandboxEnforced', () => {
  it('refuses codex read mode where the sandbox does not hold', () => {
    // The severe case: read is the DEFAULT, and the approval card presents it
    // as an analysis with no effect.
    expect(() => assertSandboxEnforced('codex', 'read', 'win32')).toThrow(
      /codex_sandbox_unenforced/,
    );
  });

  it('refuses codex write mode too — the workspace bound is just as false', () => {
    // Measured: --sandbox workspace-write wrote OUTSIDE the working directory.
    // Letting write through would keep a promise the workspace lock and
    // resolveAndCheckPath exist to make.
    expect(() => assertSandboxEnforced('codex', 'write', 'win32')).toThrow(
      /codex_sandbox_unenforced/,
    );
  });

  it('says which promise cannot be kept, per mode', () => {
    // A refusal that does not name the broken promise gets worked around.
    expect(() => assertSandboxEnforced('codex', 'read', 'win32')).toThrow(
      /cannot modify files or run shell commands/,
    );
    expect(() => assertSandboxEnforced('codex', 'write', 'win32')).toThrow(
      /stay inside the workspace/,
    );
  });

  it('names the alternative, not just the problem', () => {
    let message = '';
    try {
      assertSandboxEnforced('codex', 'read', 'win32');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/provider: "claude"/);
    expect(message).toMatch(/disallowedTools/);
    expect(message, 'the refusal should say codex still works elsewhere').toMatch(
      /Linux and macOS/,
    );
  });

  it('leaves claude alone on every platform', () => {
    // THE case that catches an over-broad guard. Claude removes the write tools
    // from the model instead of sandboxing them, so there is nothing to escape
    // — blocking it would be a regression dressed as a security fix.
    for (const platform of ['win32', 'linux', 'darwin'] as NodeJS.Platform[]) {
      for (const mode of ['read', 'write'] as const) {
        expect(
          () => assertSandboxEnforced('claude', mode, platform),
          `claude/${mode} was blocked on ${platform}`,
        ).not.toThrow();
      }
    }
  });

  it('leaves codex alone where its sandbox does hold', () => {
    for (const platform of ['linux', 'darwin'] as NodeJS.Platform[]) {
      for (const mode of ['read', 'write'] as const) {
        expect(
          () => assertSandboxEnforced('codex', mode, platform),
          `codex/${mode} was blocked on ${platform}, where it is enforced`,
        ).not.toThrow();
      }
    }
  });
});

// ─── Le câblage, pas seulement la garde ──────────────────────────────────────

describe('the real codeTaskTool, through the real executeTool', () => {
  it('refuses codex on an unenforced platform without ever asking a human', async () => {
    // Review nº2 killed the previous version of this suite with one mutation:
    // delete `preflight` from codeTaskTool and all 50 tests stayed green. The
    // cases above call the guard directly; preflight-order.test.ts builds its
    // OWN tool that declares a preflight. Neither notices that the shipped tool
    // stopped declaring one.
    //
    // That is the second time in this PR the same gap appeared: testing the
    // pieces, never the wiring. This case drives the tool that actually ships.
    if (process.platform !== 'win32') return; // only meaningful where the guard fires

    const { executeTool } = await import('../../execute');
    const { codeTaskTool } = await import('./index');
    const { spinUpTestDb, seedMinimal } = await import('@nodal-agents/db/test-utils');

    const { db } = await spinUpTestDb();
    const seed = await seedMinimal(db);

    const asked: unknown[] = [];
    const result = await executeTool(
      codeTaskTool,
      {
        purpose: 'analyse read-only',
        provider: 'codex',
        task: 'inspect the repository',
        mode: 'read',
      },
      { db, entityId: seed.entityId, agentId: seed.agentId, jobId: seed.jobId } as never,
      {
        approvalRules: [],
        onApprovalRequired: async (req: unknown) => {
          asked.push(req);
        },
      } as never,
    );

    expect(result.outcome, 'the shipped tool did not refuse').toBe('error');
    if (result.outcome !== 'error') return;
    expect(result.error).toMatch(/codex_sandbox_unenforced/);
    expect(asked, 'a human was asked to approve an unconfinable run').toHaveLength(0);
  }, 30_000);
});

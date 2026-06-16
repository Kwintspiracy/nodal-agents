// deployment.test.ts — unit tests for getDeploymentContext.
//
// Key guarantee tested: the helper does NOT throw when DATABASE_URL and
// other runner env vars are absent — it reads process.env directly, not
// the env proxy which would throw on first access without full config.
//
// House rule: assert REAL returned values, not call counts.

import { describe, it, expect, afterEach } from 'vitest';
import { getDeploymentContext } from '../../job/deployment.ts';

// Fake DB that returns a fixed install_notes value.
function makeFakeDb(installNotes = ''): Parameters<typeof getDeploymentContext>[0] {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(installNotes ? [{ value: installNotes }] : []),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => Promise.resolve(),
      }),
    }),
  } as unknown as Parameters<typeof getDeploymentContext>[0];
}

const originalEnv = { ...process.env };

afterEach(() => {
  // Restore env after each test
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe('getDeploymentContext', () => {
  it('returns loopback when BIND is absent', async () => {
    delete process.env['BIND'];
    const ctx = await getDeploymentContext(makeFakeDb());
    expect(ctx.networkMode).toBe('loopback');
  });

  it('returns loopback when BIND is 127.0.0.1', async () => {
    process.env['BIND'] = '127.0.0.1';
    const ctx = await getDeploymentContext(makeFakeDb());
    expect(ctx.networkMode).toBe('loopback');
  });

  it('returns lan when BIND is 0.0.0.0', async () => {
    process.env['BIND'] = '0.0.0.0';
    const ctx = await getDeploymentContext(makeFakeDb());
    expect(ctx.networkMode).toBe('lan');
  });

  it('returns lan when BIND is ::', async () => {
    process.env['BIND'] = '::';
    const ctx = await getDeploymentContext(makeFakeDb());
    expect(ctx.networkMode).toBe('lan');
  });

  it('os is a non-empty string', async () => {
    delete process.env['BIND'];
    const ctx = await getDeploymentContext(makeFakeDb());
    expect(typeof ctx.os).toBe('string');
    expect(ctx.os.length).toBeGreaterThan(0);
  });

  it('authMode defaults to local-trust when AUTH_MODE absent', async () => {
    delete process.env['AUTH_MODE'];
    const ctx = await getDeploymentContext(makeFakeDb());
    expect(ctx.authMode).toBe('local-trust');
  });

  it('authMode reflects AUTH_MODE env var', async () => {
    process.env['AUTH_MODE'] = 'local-auth';
    const ctx = await getDeploymentContext(makeFakeDb());
    expect(ctx.authMode).toBe('local-auth');
  });

  it('installNotes from DB when set', async () => {
    delete process.env['BIND'];
    const ctx = await getDeploymentContext(makeFakeDb('ComfyUI runs on :8188'));
    expect(ctx.installNotes).toBe('ComfyUI runs on :8188');
  });

  it('installNotes absent from result when DB returns empty', async () => {
    delete process.env['BIND'];
    const ctx = await getDeploymentContext(makeFakeDb(''));
    // Empty string → not included in result (or installNotes is falsy)
    expect(ctx.installNotes === '' || ctx.installNotes === undefined).toBe(true);
  });

  it('CRITICAL: does NOT throw when DATABASE_URL is absent (proxy-bypass guarantee)', async () => {
    // Delete DATABASE_URL — the env proxy would throw on first access.
    // getDeploymentContext must bypass it and succeed.
    const saved = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
    delete process.env['BIND'];

    let threw = false;
    try {
      await getDeploymentContext(makeFakeDb());
    } catch {
      threw = true;
    }

    // Restore
    if (saved !== undefined) process.env['DATABASE_URL'] = saved;

    expect(threw).toBe(false);
  });

  it('lanAddresses is present when networkMode is lan', async () => {
    process.env['BIND'] = '0.0.0.0';
    const ctx = await getDeploymentContext(makeFakeDb());
    expect(ctx.networkMode).toBe('lan');
    // lanAddresses should exist (may be empty array if no LAN iface in CI)
    expect(Array.isArray(ctx.lanAddresses)).toBe(true);
  });

  it('lanAddresses is absent when networkMode is loopback', async () => {
    process.env['BIND'] = '127.0.0.1';
    const ctx = await getDeploymentContext(makeFakeDb());
    expect(ctx.lanAddresses).toBeUndefined();
  });
});

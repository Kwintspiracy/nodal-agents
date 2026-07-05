// env.test.ts — unit tests for buildEnvForRunner and buildEnvForWeb

import { describe, it, expect } from 'vitest';
import { buildEnvForRunner, buildEnvForWeb } from '../lib/env.ts';
import type { Config } from '../lib/config.ts';

const BASE_CONFIG: Config = {
  llm: {
    provider: 'ollama',
    baseURL: 'http://localhost:11434',
    model: 'llama3.2',
  },
  ports: { web: 3000, runner: 3001, postgres: 25432 },
  workerSecret: 'a'.repeat(32),
  authSecret: Buffer.alloc(32, 0x7a).toString('base64'),
  bind: 'loopback',
};

const DB_URL = 'postgresql://nodalai:nodalai@localhost:25432/nodalai';

// ── buildEnvForRunner ─────────────────────────────────────────────────────────

describe('buildEnvForRunner', () => {
  it('sets AUTH_MODE=local-trust for loopback', () => {
    const env = buildEnvForRunner(BASE_CONFIG, DB_URL);
    expect(env['AUTH_MODE']).toBe('local-trust');
  });

  it('sets AUTH_MODE=local-auth for LAN (not bearer-token)', () => {
    const lanConfig: Config = { ...BASE_CONFIG, bind: 'lan' };
    const env = buildEnvForRunner(lanConfig, DB_URL);
    expect(env['AUTH_MODE']).toBe('local-auth');
  });

  it('F-11: refuses to boot (fail-loud) instead of silently ignoring bearerToken', () => {
    // Regression: bearerToken used to be silently ignored — the runner would
    // boot in local-auth/local-trust while the user believed bearer-token
    // protection was active. Must refuse instead of downgrading silently.
    const lanConfig: Config = { ...BASE_CONFIG, bind: 'lan', bearerToken: 'old-token' };
    expect(() => buildEnvForRunner(lanConfig, DB_URL)).toThrow(/bearerToken/);
  });

  it('binds 127.0.0.1 for loopback', () => {
    const env = buildEnvForRunner(BASE_CONFIG, DB_URL);
    expect(env['BIND']).toBe('127.0.0.1');
  });

  it('binds 0.0.0.0 for LAN', () => {
    const lanConfig: Config = { ...BASE_CONFIG, bind: 'lan' };
    const env = buildEnvForRunner(lanConfig, DB_URL);
    expect(env['BIND']).toBe('0.0.0.0');
  });

  it('omits LLM_* vars when llm section is absent (Brique 25)', () => {
    const noLlmConfig: Config = { ...BASE_CONFIG, llm: undefined };
    const env = buildEnvForRunner(noLlmConfig, DB_URL);
    expect(env['LLM_PROVIDER']).toBeUndefined();
    expect(env['LLM_MODEL']).toBeUndefined();
    expect(env['LLM_BASE_URL']).toBeUndefined();
    expect(env['LLM_API_KEY']).toBeUndefined();
    // Core vars still set
    expect(env['DATABASE_URL']).toBe(DB_URL);
    expect(env['AUTH_MODE']).toBe('local-trust');
  });
});

// ── buildEnvForWeb ────────────────────────────────────────────────────────────

describe('buildEnvForWeb', () => {
  it('sets AUTH_MODE=local-trust for loopback', () => {
    const env = buildEnvForWeb(BASE_CONFIG, DB_URL);
    expect(env['AUTH_MODE']).toBe('local-trust');
  });

  it('sets AUTH_MODE=local-auth for LAN (not bearer-token)', () => {
    const lanConfig: Config = { ...BASE_CONFIG, bind: 'lan' };
    const env = buildEnvForWeb(lanConfig, DB_URL);
    expect(env['AUTH_MODE']).toBe('local-auth');
  });

  it('sets NEXT_PUBLIC_AUTH_MODE to mirror AUTH_MODE for loopback', () => {
    const env = buildEnvForWeb(BASE_CONFIG, DB_URL);
    expect(env['NEXT_PUBLIC_AUTH_MODE']).toBe('local-trust');
  });

  it('sets NEXT_PUBLIC_AUTH_MODE=local-auth for LAN so login page renders correctly', () => {
    const lanConfig: Config = { ...BASE_CONFIG, bind: 'lan' };
    const env = buildEnvForWeb(lanConfig, DB_URL);
    expect(env['NEXT_PUBLIC_AUTH_MODE']).toBe('local-auth');
  });

  it('F-11: refuses to boot (fail-loud) instead of silently ignoring bearerToken', () => {
    const lanConfig: Config = { ...BASE_CONFIG, bind: 'lan', bearerToken: 'old-token' };
    expect(() => buildEnvForWeb(lanConfig, DB_URL)).toThrow(/bearerToken/);
  });

  it('always sets AUTH_SECRET (needed by better-auth in local-auth)', () => {
    const env = buildEnvForWeb(BASE_CONFIG, DB_URL);
    expect(env['AUTH_SECRET']).toBe(BASE_CONFIG.authSecret);
  });

  it('M-4: AUTH_SECRET is distinct from WORKER_SECRET', () => {
    // Regression for the audit finding: the two used to share workerSecret,
    // so a leak of WORKER_SECRET (runner auth frontier) would also forge a
    // valid better-auth session cookie.
    const env = buildEnvForWeb(BASE_CONFIG, DB_URL);
    expect(env['AUTH_SECRET']).not.toBe(env['WORKER_SECRET']);
  });

  it('M-4: falls back to a fresh (non-workerSecret) value when authSecret is absent', () => {
    // Defensive path for a caller that bypasses readConfig()'s auto-mint.
    // Must never fall back to workerSecret.
    const cfg: Config = { ...BASE_CONFIG, authSecret: undefined };
    const env = buildEnvForWeb(cfg, DB_URL);
    expect(env['AUTH_SECRET']).toBeDefined();
    expect(env['AUTH_SECRET']).not.toBe(cfg.workerSecret);
  });

  it('config.auth.mode overrides bind-derived auth mode', () => {
    // Loopback bind would default to local-trust, but explicit override wins.
    const cfg: Config = {
      ...BASE_CONFIG,
      auth: { mode: 'local-auth' },
    };
    const env = buildEnvForWeb(cfg, DB_URL);
    expect(env['AUTH_MODE']).toBe('local-auth');
    expect(env['NEXT_PUBLIC_AUTH_MODE']).toBe('local-auth');
  });

  it('does not surface Google OAuth creds when auth field is empty', () => {
    const env = buildEnvForWeb(BASE_CONFIG, DB_URL);
    expect(env['GOOGLE_CLIENT_ID']).toBeUndefined();
    expect(env['GOOGLE_CLIENT_SECRET']).toBeUndefined();
  });

  it('surfaces Google OAuth creds when configured', () => {
    const cfg: Config = {
      ...BASE_CONFIG,
      auth: {
        mode: 'local-auth',
        googleClientId: 'cid.apps.googleusercontent.com',
        googleClientSecret: 'gocspx-abc',
      },
    };
    const env = buildEnvForWeb(cfg, DB_URL);
    expect(env['GOOGLE_CLIENT_ID']).toBe('cid.apps.googleusercontent.com');
    expect(env['GOOGLE_CLIENT_SECRET']).toBe('gocspx-abc');
  });

  it('injects NEXT_SERVER_ACTIONS_ENCRYPTION_KEY when serverActionsKey is set', () => {
    const key = Buffer.alloc(32, 0xab).toString('base64');
    const cfg: Config = { ...BASE_CONFIG, serverActionsKey: key };
    const env = buildEnvForWeb(cfg, DB_URL);
    expect(env['NEXT_SERVER_ACTIONS_ENCRYPTION_KEY']).toBe(key);
  });

  it('falls back to empty string when serverActionsKey is absent (defensive)', () => {
    // readConfig auto-mints, so production never sees this. Defensive default
    // for any caller that bypasses readConfig.
    const env = buildEnvForWeb(BASE_CONFIG, DB_URL);
    expect(env['NEXT_SERVER_ACTIONS_ENCRYPTION_KEY']).toBe('');
  });
});

// ── resolveAuthMode ──────────────────────────────────────────────────────────

describe('resolveAuthMode', () => {
  it('uses bind-derived default when config.auth is missing', async () => {
    const { resolveAuthMode } = await import('../lib/env.ts');
    expect(resolveAuthMode(BASE_CONFIG)).toBe('local-trust');
    expect(resolveAuthMode({ ...BASE_CONFIG, bind: 'lan' })).toBe('local-auth');
  });

  it('uses explicit override when set', async () => {
    const { resolveAuthMode } = await import('../lib/env.ts');
    expect(
      resolveAuthMode({
        ...BASE_CONFIG,
        auth: { mode: 'local-auth' },
      }),
    ).toBe('local-auth');
    // loopback + explicit local-trust is a safe, unchanged combo.
    expect(
      resolveAuthMode({
        ...BASE_CONFIG,
        bind: 'loopback',
        auth: { mode: 'local-trust' },
      }),
    ).toBe('local-trust');
  });

  it('refuses local-trust explicitly combined with a LAN bind (Fix #12)', async () => {
    // Regression for the audit finding: auth.mode="local-trust" + bind="lan"
    // is a zero-auth pass-through on 0.0.0.0 — every runner route (including
    // run_command auto_approve) would be reachable unauthenticated on the
    // network. Must throw, never silently return local-trust.
    const { resolveAuthMode } = await import('../lib/env.ts');
    expect(() =>
      resolveAuthMode({
        ...BASE_CONFIG,
        bind: 'lan',
        auth: { mode: 'local-trust' },
      }),
    ).toThrow(/local-trust/);
  });

  it('safe combos are unchanged: loopback+local-trust, lan-with-no-mode→local-auth, loopback+local-auth', async () => {
    const { resolveAuthMode } = await import('../lib/env.ts');
    expect(resolveAuthMode({ ...BASE_CONFIG, bind: 'loopback' })).toBe('local-trust');
    expect(resolveAuthMode({ ...BASE_CONFIG, bind: 'lan' })).toBe('local-auth');
    expect(
      resolveAuthMode({ ...BASE_CONFIG, bind: 'loopback', auth: { mode: 'local-auth' } }),
    ).toBe('local-auth');
    // lan + explicit local-auth is the recommended, safe LAN combo.
    expect(resolveAuthMode({ ...BASE_CONFIG, bind: 'lan', auth: { mode: 'local-auth' } })).toBe(
      'local-auth',
    );
  });

  it('F-11: refuses to boot when bearerToken is set, regardless of bind/auth.mode', async () => {
    // The docs (self-hosting.mdx) document `bearerToken` as activating
    // AUTH_MODE=bearer-token. This function never returns that value, so
    // silently proceeding would boot in local-trust/local-auth instead of the
    // protection the user configured. Must throw for every bind/auth combo.
    const { resolveAuthMode } = await import('../lib/env.ts');
    expect(() => resolveAuthMode({ ...BASE_CONFIG, bearerToken: 'secret-token' })).toThrow(
      /bearerToken/,
    );
    expect(() =>
      resolveAuthMode({ ...BASE_CONFIG, bind: 'lan', bearerToken: 'secret-token' }),
    ).toThrow(/bearerToken/);
    expect(() =>
      resolveAuthMode({
        ...BASE_CONFIG,
        bearerToken: 'secret-token',
        auth: { mode: 'local-auth' },
      }),
    ).toThrow(/bearerToken/);
  });
});

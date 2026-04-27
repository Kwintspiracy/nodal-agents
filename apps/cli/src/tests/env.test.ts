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

  it('does not inject BEARER_TOKEN even when bearerToken is in config', () => {
    // bearerToken may still exist in old config.json files — must be ignored.
    const lanConfig: Config = { ...BASE_CONFIG, bind: 'lan', bearerToken: 'old-token' };
    const env = buildEnvForRunner(lanConfig, DB_URL);
    expect(env['BEARER_TOKEN']).toBeUndefined();
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

  it('does not inject BEARER_TOKEN even when bearerToken is in config', () => {
    const lanConfig: Config = { ...BASE_CONFIG, bind: 'lan', bearerToken: 'old-token' };
    const env = buildEnvForWeb(lanConfig, DB_URL);
    expect(env['BEARER_TOKEN']).toBeUndefined();
  });

  it('always sets AUTH_SECRET (needed by better-auth in local-auth)', () => {
    const env = buildEnvForWeb(BASE_CONFIG, DB_URL);
    expect(env['AUTH_SECRET']).toBe(BASE_CONFIG.workerSecret);
  });
});

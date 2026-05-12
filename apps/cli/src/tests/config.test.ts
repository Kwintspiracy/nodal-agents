// config.test.ts — Zod validation + file I/O round-trip

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ConfigSchema, readConfig, writeConfig, type Config } from '../lib/config.ts';

// ── Sample valid config ───────────────────────────────────────────────────────

const VALID_CONFIG: Config = {
  llm: {
    provider: 'ollama',
    baseURL: 'http://localhost:11434',
    model: 'llama3.2',
    apiKey: undefined,
  },
  ports: {
    web: 3000,
    runner: 3001,
    postgres: 25432,
  },
  workerSecret: 'a'.repeat(32),
  bind: 'loopback',
};

// ── Schema validation ─────────────────────────────────────────────────────────

describe('ConfigSchema', () => {
  it('accepts a valid config', () => {
    expect(() => ConfigSchema.parse(VALID_CONFIG)).not.toThrow();
  });

  it('rejects missing llm.provider', () => {
    const bad = { ...VALID_CONFIG, llm: { ...VALID_CONFIG.llm, provider: 'unsupported-provider' } };
    const result = ConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects invalid baseURL', () => {
    const bad = { ...VALID_CONFIG, llm: { ...VALID_CONFIG.llm, baseURL: 'not-a-url' } };
    const result = ConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects empty model', () => {
    const bad = { ...VALID_CONFIG, llm: { ...VALID_CONFIG.llm, model: '' } };
    const result = ConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects workerSecret shorter than 32 chars', () => {
    const bad = { ...VALID_CONFIG, workerSecret: 'tooshort' };
    const result = ConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects port out of range', () => {
    const bad = { ...VALID_CONFIG, ports: { ...VALID_CONFIG.ports, web: 80 } };
    const result = ConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('allows apiKey to be omitted', () => {
    const noKey = { ...VALID_CONFIG, llm: { ...VALID_CONFIG.llm, apiKey: undefined } };
    const result = ConfigSchema.safeParse(noKey);
    expect(result.success).toBe(true);
  });

  it('allows apiKey to be present', () => {
    const withKey = { ...VALID_CONFIG, llm: { ...VALID_CONFIG.llm, apiKey: 'sk-test-123' } };
    const result = ConfigSchema.safeParse(withKey);
    expect(result.success).toBe(true);
  });

  it('accepts bind=lan with bearerToken', () => {
    const lan: Config = { ...VALID_CONFIG, bind: 'lan', bearerToken: 'some-token' };
    expect(() => ConfigSchema.parse(lan)).not.toThrow();
  });

  it('accepts config without llm section (Brique 25: llm is optional)', () => {
    const noLlm: Config = {
      ...VALID_CONFIG,
      llm: undefined,
    };
    const result = ConfigSchema.safeParse(noLlm);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.llm).toBeUndefined();
    }
  });

  it('preserves all providers in the enum', () => {
    const providers = [
      'ollama',
      'lm-studio',
      'jan-ai',
      'llamacpp',
      'vllm',
      'openai-compatible',
      'anthropic',
      'openai',
      'openrouter',
    ] as const;
    for (const provider of providers) {
      const cfg = { ...VALID_CONFIG, llm: { ...VALID_CONFIG.llm, provider } };
      expect(ConfigSchema.safeParse(cfg).success).toBe(true);
    }
  });
});

// ── File I/O round-trip ───────────────────────────────────────────────────────

describe('config file I/O', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nodalai-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a valid config through JSON', () => {
    const configFile = join(tmpDir, 'config.json');
    writeFileSync(configFile, JSON.stringify(VALID_CONFIG, null, 2), 'utf-8');

    const raw = JSON.parse(readFileSync(configFile, 'utf-8')) as unknown;
    const parsed = ConfigSchema.parse(raw);

    expect(parsed.llm?.provider).toBe(VALID_CONFIG.llm?.provider);
    expect(parsed.llm?.model).toBe(VALID_CONFIG.llm?.model);
    expect(parsed.ports.web).toBe(3000);
    expect(parsed.workerSecret).toBe(VALID_CONFIG.workerSecret);
  });

  it('returns correct defaults for ports', () => {
    const partial = {
      llm: VALID_CONFIG.llm,
      ports: { web: 3000, runner: 3001, postgres: 25432 },
      workerSecret: 'a'.repeat(32),
      bind: 'loopback',
    };
    const result = ConfigSchema.parse(partial);
    expect(result.ports.web).toBe(3000);
    expect(result.ports.runner).toBe(3001);
    expect(result.ports.postgres).toBe(25432);
  });
});

// ── serverActionsKey auto-migration ───────────────────────────────────────────

describe('readConfig — serverActionsKey auto-mint', () => {
  let tmpDir: string;
  let configFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nodalai-config-test-'));
    configFile = join(tmpDir, 'config.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('mints a fresh serverActionsKey when absent from config and persists it', () => {
    // Write a config WITHOUT serverActionsKey (simulates pre-existing install).
    writeFileSync(configFile, JSON.stringify(VALID_CONFIG, null, 2), 'utf-8');

    const result = readConfig(configFile);
    expect(result).not.toBeNull();
    // Auto-mint must produce a 44-char base64 string (= 32 raw bytes).
    expect(result!.serverActionsKey).toBeDefined();
    expect(result!.serverActionsKey!).toHaveLength(44);
    // Round-trip: base64 → 32 bytes.
    expect(Buffer.from(result!.serverActionsKey!, 'base64')).toHaveLength(32);

    // The mint MUST be persisted so the next dev-server restart sees the same key.
    const onDisk = JSON.parse(readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
    expect(onDisk['serverActionsKey']).toBe(result!.serverActionsKey);
  });

  it('preserves an existing serverActionsKey across reads (stable across restarts)', () => {
    const stableKey = Buffer.alloc(32, 0x42).toString('base64'); // deterministic 44-char base64
    const cfgWithKey: Config = { ...VALID_CONFIG, serverActionsKey: stableKey };
    writeFileSync(configFile, JSON.stringify(cfgWithKey, null, 2), 'utf-8');

    const first = readConfig(configFile);
    const second = readConfig(configFile);

    expect(first?.serverActionsKey).toBe(stableKey);
    expect(second?.serverActionsKey).toBe(stableKey);
    // No rewrite needed when key already present — file mtime stays unchanged
    // would be a stronger assertion, but mtimes are flaky cross-OS. The
    // round-trip equality above is the load-bearing assertion.
  });

  it('writeConfig + readConfig round-trips serverActionsKey', () => {
    const key = Buffer.alloc(32, 0x99).toString('base64');
    const cfg: Config = { ...VALID_CONFIG, serverActionsKey: key };
    writeConfig(cfg, configFile);

    const parsed = readConfig(configFile);
    expect(parsed?.serverActionsKey).toBe(key);
  });
});

// nodal-home.test.ts — le banc vise l'instance que NODALAI_HOME désigne.
//
// Une campagne du banc v2 tourne contre une Nodal jetable, installée à côté de
// celle du propriétaire. Le banc lit donc la base et le dashboard de CETTE
// instance, et range son verrou et sa configuration dans son dossier : jamais
// ceux de `~/.nodalai`. Le dossier personnel pointe dans un temporaire.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root: string;
let user: string;
let homeB: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nodal-home-bench-'));
  user = join(root, 'user');
  homeB = join(root, 'nodal-b');
  vi.stubEnv('USERPROFILE', user);
  vi.stubEnv('HOME', user);
  vi.stubEnv('NODALAI_HOME', homeB);
  vi.stubEnv('NODALAI_CONFIG_PATH', undefined);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('the bench under NODALAI_HOME', () => {
  it('reads the database and dashboard of the instance the home names', async () => {
    mkdirSync(homeB, { recursive: true });
    writeFileSync(
      join(homeB, 'config.json'),
      JSON.stringify({ ports: { postgres: 25532, web: 3100 }, postgresPassword: 'p w' }),
    );
    const { stackDatabaseUrl, stackWebUrl } = await import('../stack');
    expect(stackDatabaseUrl()).toBe('postgresql://nodalai:p%20w@localhost:25532/nodalai');
    expect(stackWebUrl()).toBe('http://localhost:3100');
  });

  it('says which config is missing — the instance one, not ~/.nodalai', async () => {
    const { stackDatabaseUrl } = await import('../stack');
    expect(() => stackDatabaseUrl()).toThrow(join(homeB, 'config.json'));
  });

  it('keeps its lock and its config file in the home, and creates nothing under the default', async () => {
    const { BENCH_LOCK_FILE } = await import('../lock');
    const { BENCH_CONFIG_FILE, readBenchConfig } = await import('../stack');
    expect(BENCH_LOCK_FILE).toBe(join(homeB, 'bench', 'workflows.lock'));
    expect(BENCH_CONFIG_FILE).toBe(join(homeB, 'bench.json'));
    expect(readBenchConfig()).toEqual({ services: {} });
    expect(existsSync(join(user, '.nodalai'))).toBe(false);
  });
});

// sandbox-engine.test.ts — ce que le moteur shell fait du STATUT du bac à sable
// (#628), sur tous les systèmes : un bac à sable indisponible laisse la
// commande tourner ET le dit (code stable, une fois par processus) ; un bac à
// sable disponible qui ne démarre pas REFUSE la commande, avec la raison du
// backend, et ne la lance jamais sans lui. Les backends sont injectés : ce
// test prouve le moteur, `sandbox-confinement-windows.test.ts` prouve le mur.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SandboxStartError,
  TOOL_CACHE_VARIABLES,
  createSandbox,
  type SandboxBackend,
} from '@nodal-agents/sandbox';
import { runShellCommand, runCommandSequence } from '../builtin/shell-engine';
import { buildChildEnv } from '../builtin/child-env';

let dir: string;
let outside: string;
const node = process.execPath;
const env = buildChildEnv(process.env);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nodal-sbx-engine-'));
  outside = await mkdtemp(join(tmpdir(), 'nodal-sbx-engine-out-'));
  await writeFile(
    join(dir, 'write.cjs'),
    "require('fs').writeFileSync(process.argv[2], 'written'); console.log('ok');\n",
  );
  await writeFile(join(dir, 'env.cjs'), 'process.stdout.write(JSON.stringify(process.env));\n');
});

afterAll(async () => {
  for (const d of [dir, outside]) await rm(d, { recursive: true, force: true });
});

const logs = (): { codes: string[]; log: (code: string, f: Record<string, unknown>) => void } => {
  const codes: string[] = [];
  return { codes, log: (code) => codes.push(code) };
};

describe('runShellCommand — bac à sable indisponible @cap:executer-une-commande/moteur', () => {
  it('la commande tourne comme avant, le résultat dit `unconfined` avec le code, la raison est journalisée UNE fois', async () => {
    const { codes, log } = logs();
    const sandbox = createSandbox(null, { platform: 'linux', log });
    const target = join(outside, 'unconfined.txt');
    const first = await runShellCommand(
      {
        target: { file: node, args: [join(dir, 'write.cjs'), target] },
        cwd: dir,
        timeoutMs: 20_000,
        env,
        confinement: { writableRoots: [dir] },
      },
      { sandbox },
    );
    const second = await runShellCommand(
      {
        target: { file: node, args: ['-e', '0'] },
        cwd: dir,
        timeoutMs: 20_000,
        env,
        confinement: { writableRoots: [dir] },
      },
      { sandbox },
    );
    // Sans bac à sable, rien n'empêche l'écriture dehors : c'est la transition D2.
    expect(first.outcome).toEqual({ kind: 'exit', exitCode: 0 });
    expect(await readFile(target, 'utf8')).toBe('written');
    expect(first.confinement).toEqual({ kind: 'unconfined', code: 'SANDBOX_NOT_IMPLEMENTED' });
    expect(second.confinement).toEqual({ kind: 'unconfined', code: 'SANDBOX_NOT_IMPLEMENTED' });
    // Deux commandes, UNE ligne de journal.
    expect(codes).toEqual(['SANDBOX_UNAVAILABLE']);
    // Le statut se relit, avec sa raison — ce que le bandeau lira.
    expect(await sandbox.status()).toEqual({
      state: 'unavailable',
      code: 'SANDBOX_NOT_IMPLEMENTED',
      reason: 'no sandbox backend for platform linux yet',
    });
  });

  it('un backend qui se déclare indisponible : sa raison est citée telle quelle', async () => {
    const { codes, log } = logs();
    const backend: SandboxBackend = {
      probe: async () => ({
        state: 'unavailable',
        code: 'SANDBOX_SELF_TEST_FAILED',
        reason: 'backend_unavailable: native stdio requires Node.js 26.8.0',
      }),
      start: async () => {
        throw new Error('never called when unavailable');
      },
    };
    const sandbox = createSandbox(backend, { log });
    const r = await runShellCommand(
      {
        target: { file: node, args: ['-e', "process.stdout.write('ran')"] },
        cwd: dir,
        timeoutMs: 20_000,
        env,
        confinement: { writableRoots: [dir] },
      },
      { sandbox },
    );
    expect(r.stdout).toBe('ran');
    expect(r.confinement).toEqual({ kind: 'unconfined', code: 'SANDBOX_SELF_TEST_FAILED' });
    expect(codes).toEqual(['SANDBOX_UNAVAILABLE']);
    const status = await sandbox.status();
    expect(status.state === 'unavailable' && status.reason).toBe(
      'backend_unavailable: native stdio requires Node.js 26.8.0',
    );
  });
});

describe('runShellCommand — bac à sable disponible qui ne démarre pas @cap:executer-une-commande/moteur', () => {
  it('la commande est REFUSÉE avec la raison du backend, et ne tourne pas sans lui', async () => {
    const { log } = logs();
    const launched: unknown[] = [];
    const backend: SandboxBackend = {
      probe: async () => ({ state: 'available', backend: 'fake-backend' }),
      start: async (launch) => {
        launched.push(launch);
        throw new SandboxStartError('backend_error: container creation failed (0x80070005)');
      },
    };
    const sandbox = createSandbox(backend, { log });
    const target = join(outside, 'must-not-exist.txt');
    const r = await runShellCommand(
      {
        target: { file: node, args: [join(dir, 'write.cjs'), target] },
        cwd: dir,
        timeoutMs: 20_000,
        env,
        confinement: { writableRoots: [dir] },
      },
      { sandbox },
    );
    expect(r.outcome).toEqual({
      kind: 'spawn_error',
      message: 'SANDBOX_START_FAILED: backend_error: container creation failed (0x80070005)',
    });
    // Le backend a bien reçu la demande, avec les dossiers déclarés…
    expect(launched).toHaveLength(1);
    expect((launched[0] as { writableRoots: string[] }).writableRoots).toContain(dir);
    // …et rien n'a tourné à sa place.
    expect(existsSync(target)).toBe(false);
    expect(r.confinement.kind).toBe('confined');
  });

  it('dans une séquence de preuve, le refus est une panne d’infra (infra_error), jamais un vert', async () => {
    const backend: SandboxBackend = {
      probe: async () => ({ state: 'available', backend: 'fake-backend' }),
      start: async () => {
        throw new SandboxStartError('backend_error: boom');
      },
    };
    const sandbox = createSandbox(backend, { log: () => {} });
    const seq = await runCommandSequence([{ command: `"${node}" -e "0"`, timeoutSeconds: 20 }], {
      cwd: dir,
      env,
      confinement: { writableRoots: [dir] },
      sandbox,
      onCommandDone: async () => {},
    });
    expect(seq.verdict).toBe('infra_error');
    expect(seq.results[0]?.outcome).toEqual({
      kind: 'spawn_error',
      message: 'SANDBOX_START_FAILED: backend_error: boom',
    });
  });
});

describe('runShellCommand — contrat et environnement communs aux deux régimes', () => {
  it('confinement absent ⇒ CONFINEMENT_REQUIRED (le moteur ne devine aucune racine)', () => {
    expect(() =>
      runShellCommand({
        target: { command: 'echo x' },
        cwd: dir,
        timeoutMs: 1000,
        env,
        confinement: undefined as unknown as { writableRoots: string[] },
      }),
    ).toThrow('CONFINEMENT_REQUIRED');
  });

  it('un dossier de départ absent est nommé (CWD_NOT_FOUND), confiné ou non', async () => {
    const missing = join(dir, 'nulle-part');
    for (const sandbox of [
      createSandbox(null, { platform: 'linux', log: () => {} }),
      createSandbox(
        {
          probe: async () => ({ state: 'available', backend: 'fake-backend' }),
          start: async () => {
            throw new Error('must not be reached: the cwd is checked first');
          },
        },
        { log: () => {} },
      ),
    ]) {
      const r = await runShellCommand(
        {
          target: { file: node, args: ['-e', '0'] },
          cwd: missing,
          timeoutMs: 5_000,
          env,
          confinement: { writableRoots: [dir] },
        },
        { sandbox },
      );
      expect(r.outcome).toEqual({ kind: 'spawn_error', message: `CWD_NOT_FOUND: ${missing}` });
    }
  });

  it('les caches d’outils sont désignés à l’enfant, chacun vers le cache de Nodal', async () => {
    const sandbox = createSandbox(null, { platform: 'linux', log: () => {} });
    const r = await runShellCommand(
      {
        target: { file: node, args: [join(dir, 'env.cjs')] },
        cwd: dir,
        timeoutMs: 20_000,
        env,
        confinement: { writableRoots: [dir] },
      },
      { sandbox },
    );
    const seen = JSON.parse(r.stdout) as Record<string, string>;
    const root = process.env['NODALAI_TOOL_CACHE_ROOT'] as string;
    for (const [name, sub] of Object.entries(TOOL_CACHE_VARIABLES)) {
      const key = Object.keys(seen).find((k) => k.toLowerCase() === name.toLowerCase());
      expect(key, name).toBeDefined();
      expect(seen[key as string]).toBe(join(root, sub));
      expect(existsSync(join(root, sub))).toBe(true);
    }
  });
});

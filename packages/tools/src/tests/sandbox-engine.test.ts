// sandbox-engine.test.ts — ce que le moteur shell fait du STATUT du bac à sable
// et du PÉRIMÈTRE du job (#628), sur tous les systèmes :
//   - un bac à sable indisponible laisse la commande tourner ET le dit (code
//     stable, une fois par processus) ;
//   - un bac à sable disponible qui ne démarre pas REFUSE la commande, avec la
//     raison du backend, et ne la lance jamais sans lui ;
//   - le Stop (`signal`) tue la commande en cours ;
//   - sans bac à sable, sous Unix, ce qu'une commande laisse tourner vit
//     jusqu'à la fermeture du périmètre du job, puis meurt.
// Les backends sont injectés : ce test prouve le moteur ;
// `sandbox-confinement-windows.test.ts` prouve le mur et le conteneur du job.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JobProcessScope,
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
const scopes: JobProcessScope[] = [];
/** Un périmètre sous un bac à sable donné, fermé en fin de suite. */
const scopeWith = (
  id: string,
  sandbox = createSandbox(null, { platform: 'linux', log: () => {} }),
): JobProcessScope => {
  const s = new JobProcessScope(id, sandbox);
  scopes.push(s);
  return s;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nodal-sbx-engine-'));
  outside = await mkdtemp(join(tmpdir(), 'nodal-sbx-engine-out-'));
  await writeFile(
    join(dir, 'write.cjs'),
    "require('fs').writeFileSync(process.argv[2], 'written'); console.log('ok');\n",
  );
  await writeFile(join(dir, 'env.cjs'), 'process.stdout.write(JSON.stringify(process.env));\n');
  await writeFile(
    join(dir, 'server.cjs'),
    "const fs = require('fs'); require('http').createServer((q, s) => s.end('pong ' + process.pid)).listen(0, '127.0.0.1', function () { fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, port: this.address().port })); });\n",
  );
  await writeFile(
    join(dir, 'fetch.cjs'),
    "fetch('http://127.0.0.1:' + process.argv[2] + '/').then((r) => r.text()).then((t) => console.log(t)).catch((e) => { console.log('ERR', e.cause && e.cause.code); process.exit(2); });\n",
  );
  await writeFile(
    join(dir, 'long.cjs'),
    "require('fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => {}, 600000);\n",
  );
});

afterAll(async () => {
  for (const s of scopes) await s.close();
  for (const d of [dir, outside]) await rm(d, { recursive: true, force: true });
});

const logs = (): { codes: string[]; log: (code: string, f: Record<string, unknown>) => void } => {
  const codes: string[] = [];
  return { codes, log: (code) => codes.push(code) };
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForFile = async (path: string): Promise<void> => {
  for (let i = 0; i < 200 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 50));
};

describe('runShellCommand — bac à sable indisponible @cap:executer-une-commande/moteur', () => {
  it('la commande tourne comme avant, le résultat dit `unconfined` avec le code, la raison est journalisée UNE fois', async () => {
    const { codes, log } = logs();
    const scope = scopeWith('unavailable', createSandbox(null, { platform: 'linux', log }));
    const target = join(outside, 'unconfined.txt');
    const first = await runShellCommand({
      target: { file: node, args: [join(dir, 'write.cjs'), target] },
      cwd: dir,
      timeoutMs: 20_000,
      env,
      confinement: { writableRoots: [dir] },
      scope,
    });
    const second = await runShellCommand({
      target: { file: node, args: ['-e', '0'] },
      cwd: dir,
      timeoutMs: 20_000,
      env,
      confinement: { writableRoots: [dir] },
      scope,
    });
    // Sans bac à sable, rien n'empêche l'écriture dehors : c'est la transition D2.
    expect(first.outcome).toEqual({ kind: 'exit', exitCode: 0 });
    expect(await readFile(target, 'utf8')).toBe('written');
    expect(first.confinement).toEqual({ kind: 'unconfined', code: 'SANDBOX_NOT_IMPLEMENTED' });
    expect(second.confinement).toEqual({ kind: 'unconfined', code: 'SANDBOX_NOT_IMPLEMENTED' });
    // Deux commandes, UNE ligne de journal.
    expect(codes).toEqual(['SANDBOX_UNAVAILABLE']);
    // Le statut se relit, avec sa raison — ce que le bandeau lira.
    expect(await scope.sandbox.status()).toEqual({
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
      openContainer: async () => {
        throw new Error('never called when unavailable');
      },
    };
    const scope = scopeWith('declared-unavailable', createSandbox(backend, { log }));
    const r = await runShellCommand({
      target: { file: node, args: ['-e', "process.stdout.write('ran')"] },
      cwd: dir,
      timeoutMs: 20_000,
      env,
      confinement: { writableRoots: [dir] },
      scope,
    });
    expect(r.stdout).toBe('ran');
    expect(r.confinement).toEqual({ kind: 'unconfined', code: 'SANDBOX_SELF_TEST_FAILED' });
    expect(codes).toEqual(['SANDBOX_UNAVAILABLE']);
    const status = await scope.sandbox.status();
    expect(status.state === 'unavailable' && status.reason).toBe(
      'backend_unavailable: native stdio requires Node.js 26.8.0',
    );
  });
});

describe('runShellCommand — bac à sable disponible qui ne démarre pas @cap:executer-une-commande/moteur', () => {
  it('la commande est REFUSÉE avec la raison du backend, et ne tourne pas sans lui', async () => {
    const opened: (readonly string[])[] = [];
    const backend: SandboxBackend = {
      probe: async () => ({ state: 'available', backend: 'fake-backend' }),
      openContainer: async (roots) => {
        opened.push(roots);
        throw new SandboxStartError('backend_error: container creation failed (0x80070005)');
      },
    };
    const scope = scopeWith('refused', createSandbox(backend, { log: () => {} }));
    const target = join(outside, 'must-not-exist.txt');
    const r = await runShellCommand({
      target: { file: node, args: [join(dir, 'write.cjs'), target] },
      cwd: dir,
      timeoutMs: 20_000,
      env,
      confinement: { writableRoots: [dir] },
      scope,
    });
    expect(r.outcome).toEqual({
      kind: 'spawn_error',
      message: 'SANDBOX_START_FAILED: backend_error: container creation failed (0x80070005)',
    });
    // Le backend a bien reçu la demande, avec les dossiers déclarés…
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain(dir);
    // …et rien n'a tourné à sa place.
    expect(existsSync(target)).toBe(false);
    expect(r.confinement.kind).toBe('confined');
  });

  it('dans une séquence de preuve, le refus est une panne d’infra (infra_error), jamais un vert', async () => {
    const backend: SandboxBackend = {
      probe: async () => ({ state: 'available', backend: 'fake-backend' }),
      openContainer: async () => {
        throw new SandboxStartError('backend_error: boom');
      },
    };
    const scope = scopeWith('refused-seq', createSandbox(backend, { log: () => {} }));
    const seq = await runCommandSequence([{ command: `"${node}" -e "0"`, timeoutSeconds: 20 }], {
      cwd: dir,
      env,
      confinement: { writableRoots: [dir] },
      scope,
      onCommandDone: async () => {},
    });
    expect(seq.verdict).toBe('infra_error');
    expect(seq.results[0]?.outcome).toEqual({
      kind: 'spawn_error',
      message: 'SANDBOX_START_FAILED: backend_error: boom',
    });
  });
});

describe('runShellCommand — le Stop du job (#750) @cap:executer-une-commande/moteur', () => {
  it('le signal tue la commande en cours : ABORTED, bien avant son timeout, et son processus est mort', async () => {
    const scope = scopeWith('abort');
    const pidFile = join(dir, 'abort.pid');
    const controller = new AbortController();
    const started = Date.now();
    const running = runShellCommand({
      target: { file: node, args: [join(dir, 'long.cjs'), pidFile] },
      cwd: dir,
      timeoutMs: 120_000,
      env,
      confinement: { writableRoots: [dir] },
      scope,
      signal: controller.signal,
    });
    await waitForFile(pidFile);
    const pid = Number(await readFile(pidFile, 'utf8'));
    controller.abort();
    const r = await running;
    expect(r.outcome).toEqual({ kind: 'spawn_error', message: 'ABORTED' });
    expect(Date.now() - started).toBeLessThan(30_000);
    await new Promise((res) => setTimeout(res, 1_000));
    expect(alive(pid)).toBe(false);
  });

  it('un job déjà arrêté ne lance plus rien', async () => {
    const scope = scopeWith('pre-aborted');
    const controller = new AbortController();
    controller.abort();
    const target = join(outside, 'after-stop.txt');
    const r = await runShellCommand({
      target: { file: node, args: [join(dir, 'write.cjs'), target] },
      cwd: dir,
      timeoutMs: 20_000,
      env,
      confinement: { writableRoots: [dir] },
      scope,
      signal: controller.signal,
    });
    expect(r.outcome).toEqual({ kind: 'spawn_error', message: 'ABORTED' });
    expect(existsSync(target)).toBe(false);
  });
});

// Sans bac à sable, sous Windows, un petit-enfant DÉTACHÉ dont le parent est
// mort n'est plus rattaché à rien : rien ne le tue (limite dite dans
// job-scope.ts). Le conteneur MXC du job, lui, le tient : c'est
// `sandbox-confinement-windows.test.ts` qui le prouve.
describe.skipIf(process.platform === 'win32')(
  'runShellCommand — sans bac à sable, ce qu’une commande laisse tourner vit jusqu’à la fin du JOB @cap:executer-une-commande/moteur (Unix: process groups; skipped on Windows, where only the MXC job container holds a detached grandchild)',
  () => {
    const startServer = (scope: JobProcessScope, infoFile: string) =>
      runShellCommand({
        target: {
          command: `"${node}" "${join(dir, 'server.cjs')}" "${infoFile}" > /dev/null 2>&1 &`,
        },
        cwd: dir,
        timeoutMs: 20_000,
        env,
        confinement: { writableRoots: [dir] },
        scope,
      });
    const readInfo = async (infoFile: string): Promise<{ pid: number; port: number }> => {
      await waitForFile(infoFile);
      return JSON.parse(await readFile(infoFile, 'utf8')) as { pid: number; port: number };
    };
    const fetchFrom = (scope: JobProcessScope, port: number) =>
      runShellCommand({
        target: { file: node, args: [join(dir, 'fetch.cjs'), String(port)] },
        cwd: dir,
        timeoutMs: 20_000,
        env,
        confinement: { writableRoots: [dir] },
        scope,
      });

    it('la commande 2 joint le serveur que la commande 1 a lancé ; fermer le job le tue', async () => {
      const scope = scopeWith('lifetime');
      const infoFile = join(dir, 'server-a.json');
      const first = await startServer(scope, infoFile);
      expect(first.outcome).toEqual({ kind: 'exit', exitCode: 0 });
      const { pid, port } = await readInfo(infoFile);
      const second = await fetchFrom(scope, port);
      expect(second.stdout.trim()).toBe(`pong ${pid}`);
      expect(alive(pid)).toBe(true);
      await scope.close();
      await new Promise((r) => setTimeout(r, 500));
      expect(alive(pid)).toBe(false);
    });

    it('fermer UN job ne touche pas aux processus d’un autre', async () => {
      const a = scopeWith('job-a');
      const b = scopeWith('job-b');
      const infoA = join(dir, 'server-ja.json');
      const infoB = join(dir, 'server-jb.json');
      await startServer(a, infoA);
      await startServer(b, infoB);
      const pa = await readInfo(infoA);
      const pb = await readInfo(infoB);
      await a.close();
      await new Promise((r) => setTimeout(r, 500));
      expect(alive(pa.pid)).toBe(false);
      expect(alive(pb.pid)).toBe(true);
      expect((await fetchFrom(b, pb.port)).stdout.trim()).toBe(`pong ${pb.pid}`);
      await b.close();
    });
  },
);

describe('runShellCommand — contrat et environnement communs aux deux régimes', () => {
  it('confinement absent ⇒ CONFINEMENT_REQUIRED ; périmètre absent ⇒ SCOPE_REQUIRED', () => {
    const scope = scopeWith('contract');
    expect(() =>
      runShellCommand({
        target: { command: 'echo x' },
        cwd: dir,
        timeoutMs: 1000,
        env,
        confinement: undefined as unknown as { writableRoots: string[] },
        scope,
      }),
    ).toThrow('CONFINEMENT_REQUIRED');
    expect(() =>
      runShellCommand({
        target: { command: 'echo x' },
        cwd: dir,
        timeoutMs: 1000,
        env,
        confinement: { writableRoots: [dir] },
        scope: undefined as unknown as JobProcessScope,
      }),
    ).toThrow('SCOPE_REQUIRED');
  });

  it('un dossier de départ absent est nommé (CWD_NOT_FOUND), confiné ou non', async () => {
    const missing = join(dir, 'nulle-part');
    for (const scope of [
      scopeWith('cwd-unconfined'),
      scopeWith(
        'cwd-confined',
        createSandbox(
          {
            probe: async () => ({ state: 'available', backend: 'fake-backend' }),
            openContainer: async () => {
              throw new Error('must not be reached: the cwd is checked first');
            },
          },
          { log: () => {} },
        ),
      ),
    ]) {
      const r = await runShellCommand({
        target: { file: node, args: ['-e', '0'] },
        cwd: missing,
        timeoutMs: 5_000,
        env,
        confinement: { writableRoots: [dir] },
        scope,
      });
      expect(r.outcome).toEqual({ kind: 'spawn_error', message: `CWD_NOT_FOUND: ${missing}` });
    }
  });

  it('les caches d’outils sont désignés à l’enfant, chacun vers le cache de Nodal', async () => {
    const r = await runShellCommand({
      target: { file: node, args: [join(dir, 'env.cjs')] },
      cwd: dir,
      timeoutMs: 20_000,
      env,
      confinement: { writableRoots: [dir] },
      scope: scopeWith('cache-env'),
    });
    const seen = JSON.parse(r.stdout) as Record<string, string>;
    const root = process.env['NODALAI_TOOL_CACHE_ROOT'] as string;
    for (const [name, sub] of Object.entries(TOOL_CACHE_VARIABLES)) {
      const key = Object.keys(seen).find((k) => k.toLowerCase() === name.toLowerCase());
      expect(key, name).toBeDefined();
      expect(seen[key as string]).toBe(join(root, sub));
      expect(existsSync(join(root, sub))).toBe(true);
    }
  });

  it('une commande dont un processus d’arrière-plan garde le tuyau de sortie finit sans attendre son timeout', async () => {
    const scope = scopeWith('pipe-holder');
    const info = join(dir, 'holder.json');
    const command =
      process.platform === 'win32'
        ? `start "" /b "${node}" "${join(dir, 'server.cjs')}" "${info}"`
        : `"${node}" "${join(dir, 'server.cjs')}" "${info}" &`;
    const started = Date.now();
    const r = await runShellCommand({
      target: { command },
      cwd: dir,
      timeoutMs: 30_000,
      env,
      confinement: { writableRoots: [dir] },
      scope,
    });
    expect(r.outcome).toEqual({ kind: 'exit', exitCode: 0 });
    expect(Date.now() - started).toBeLessThan(10_000);
    await waitForFile(info);
    const { pid } = JSON.parse(await readFile(info, 'utf8')) as { pid: number };
    await scope.close();
    // Sous Windows sans bac à sable, la fermeture du périmètre n'atteint pas
    // ce petit-enfant détaché (limite dite) : le test le tue lui-même.
    try {
      process.kill(pid);
    } catch {
      /* déjà mort */
    }
  });
});

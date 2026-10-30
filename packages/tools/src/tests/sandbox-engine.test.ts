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

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JobProcessScope,
  SandboxStartError,
  TOOL_CACHE_VARIABLES,
  createSandbox,
  noWorkspaceSandbox,
  type ConfinementPolicy,
  type SandboxBackend,
} from '@nodal-agents/sandbox';
import { runShellCommand, runCommandSequence } from '../builtin/shell-engine';
import { buildChildEnv } from '../builtin/child-env';
import { mustDie, readCounter, watchProcess, watchRegistry } from '@nodal-agents/test-kit';

let dir: string;
let outside: string;
const node = process.execPath;
const env = buildChildEnv(process.env);
const scopes: JobProcessScope[] = [];
/**
 * Un périmètre sous un bac à sable donné, fermé en fin de suite. Son
 * identifiant est unique : sous Unix, fermer un périmètre tue tout processus
 * qui porte son identifiant (#750), et les fichiers de test tournent côte à
 * côte.
 */
const scopeWith = (
  id: string,
  sandbox = createSandbox(null, { platform: 'linux', log: () => {} }),
): JobProcessScope => {
  const s = new JobProcessScope(`${id}-${randomUUID()}`, sandbox);
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

// Un serveur vit ou meurt SUR LE PROCESSUS TENU, jamais sur son pid : Windows
// redonne un pid libéré en quelques secondes (test-kit process-watch.ts).
const watches = watchRegistry();
afterEach(() => watches.releaseAll());

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
      confinement: { writableRoots: [dir], workspace: noWorkspaceSandbox },
      scope,
    });
    const second = await runShellCommand({
      target: { file: node, args: ['-e', '0'] },
      cwd: dir,
      timeoutMs: 20_000,
      env,
      confinement: { writableRoots: [dir], workspace: noWorkspaceSandbox },
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
      confinement: { writableRoots: [dir], workspace: noWorkspaceSandbox },
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
      confinement: { writableRoots: [dir], workspace: noWorkspaceSandbox },
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
      confinement: { writableRoots: [dir], workspace: noWorkspaceSandbox },
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
      confinement: { writableRoots: [dir], workspace: noWorkspaceSandbox },
      scope,
      signal: controller.signal,
    });
    await waitForFile(pidFile);
    const long = await watches.hold(readCounter(pidFile));
    controller.abort();
    const r = await running;
    expect(r.outcome).toEqual({ kind: 'spawn_error', message: 'ABORTED' });
    expect(Date.now() - started).toBeLessThan(30_000);
    await mustDie(long, 'the aborted command', 'the Stop signal');
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
      confinement: { writableRoots: [dir], workspace: noWorkspaceSandbox },
      scope,
      signal: controller.signal,
    });
    expect(r.outcome).toEqual({ kind: 'spawn_error', message: 'ABORTED' });
    expect(existsSync(target)).toBe(false);
  });
});

// Sans bac à sable, ce qu'une commande détache vit pour la commande suivante
// et meurt avec le job, sur chaque OS (#755) : sous Windows le Job Object du
// job tient le serveur que `start /b` a détaché ; sous Unix, son groupe et
// l'étiquette du job.
describe('runShellCommand — sans bac à sable, ce qu’une commande laisse tourner vit jusqu’à la fin du JOB @cap:executer-une-commande/moteur', () => {
  const startServer = (scope: JobProcessScope, infoFile: string) =>
    runShellCommand({
      target: {
        command:
          process.platform === 'win32'
            ? `start "" /b "${node}" "${join(dir, 'server.cjs')}" "${infoFile}"`
            : `"${node}" "${join(dir, 'server.cjs')}" "${infoFile}" > /dev/null 2>&1 &`,
      },
      cwd: dir,
      timeoutMs: 20_000,
      env,
      confinement: { writableRoots: [dir], workspace: noWorkspaceSandbox },
      scope,
    });
  // Le fichier peut exister avant que le serveur ait fini de l'écrire : on
  // relit jusqu'à un JSON complet (vu en CI : « Unexpected end of JSON »).
  const readInfo = async (infoFile: string): Promise<{ pid: number; port: number }> => {
    await waitForFile(infoFile);
    for (let i = 0; ; i++) {
      try {
        return JSON.parse(await readFile(infoFile, 'utf8')) as { pid: number; port: number };
      } catch (e) {
        if (i >= 100) throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  };
  const fetchFrom = (scope: JobProcessScope, port: number) =>
    runShellCommand({
      target: { file: node, args: [join(dir, 'fetch.cjs'), String(port)] },
      cwd: dir,
      timeoutMs: 20_000,
      env,
      confinement: { writableRoots: [dir], workspace: noWorkspaceSandbox },
      scope,
    });

  it('la commande 2 joint le serveur que la commande 1 a lancé ; fermer le job le tue', async () => {
    const scope = scopeWith('lifetime');
    const infoFile = join(dir, 'server-a.json');
    const first = await startServer(scope, infoFile);
    expect(first.outcome).toEqual({ kind: 'exit', exitCode: 0 });
    const { pid, port } = await readInfo(infoFile);
    const server = await watches.hold(pid);
    const second = await fetchFrom(scope, port);
    expect(second.stdout.trim()).toBe(`pong ${pid}`);
    expect(server.alive(), 'the server, after command 2').toBe(true);
    await scope.close();
    await mustDie(server, 'server', 'scope.close()');
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
    const serverA = await watches.hold(pa.pid);
    const serverB = await watches.hold(pb.pid);
    await a.close();
    await mustDie(serverA, 'server of job A', 'a.close()');
    expect(serverB.alive(), 'the server of job B, after job A closed').toBe(true);
    expect((await fetchFrom(b, pb.port)).stdout.trim()).toBe(`pong ${pb.pid}`);
    await b.close();
    await mustDie(serverB, 'server of job B', 'b.close()');
  });
});

describe('runShellCommand — contrat et environnement communs aux deux régimes', () => {
  it('confinement absent ⇒ CONFINEMENT_REQUIRED ; périmètre absent ⇒ SCOPE_REQUIRED', () => {
    const scope = scopeWith('contract');
    expect(() =>
      runShellCommand({
        target: { command: 'echo x' },
        cwd: dir,
        timeoutMs: 1000,
        env,
        confinement: undefined as unknown as ConfinementPolicy,
        scope,
      }),
    ).toThrow('CONFINEMENT_REQUIRED');
    expect(() =>
      runShellCommand({
        target: { command: 'echo x' },
        cwd: dir,
        timeoutMs: 1000,
        env,
        confinement: { writableRoots: [dir], workspace: noWorkspaceSandbox },
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
        confinement: { writableRoots: [dir], workspace: noWorkspaceSandbox },
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
      confinement: { writableRoots: [dir], workspace: noWorkspaceSandbox },
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
      confinement: { writableRoots: [dir], workspace: noWorkspaceSandbox },
      scope,
    });
    expect(r.outcome).toEqual({ kind: 'exit', exitCode: 0 });
    expect(Date.now() - started).toBeLessThan(10_000);
    await waitForFile(info);
    const { pid } = JSON.parse(await readFile(info, 'utf8')) as { pid: number };
    // Tenu dès que son pid est lu, quand il vit (il garde le tuyau) : après la
    // fermeture du périmètre il peut être mort, et son pid redonné (#841).
    const watch = await watchProcess(pid);
    try {
      await scope.close();
      // Sous Windows sans bac à sable, la fermeture du périmètre n'atteint pas
      // ce petit-enfant détaché (limite dite) : le test le tue lui-même.
      watch.kill();
    } finally {
      watch.release();
    }
  });
});

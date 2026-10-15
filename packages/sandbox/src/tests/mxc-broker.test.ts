// mxc-broker.test.ts — un courtier qui ne démarre pas ne laisse RIEN en
// attente (#628, invariant #4). Le Node du courtier est un chemin qui
// n'existe pas : le lancement échoue, sur tous les systèmes, sans SDK.
// Chaque attente sur le courtier (ouvrir un conteneur, sa fin, la sonde) se
// règle par une erreur codée, jamais par un silence.

import { describe, it, expect } from 'vitest';
import { join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import type { ContainerRequest } from '@microsoft/mxc-sdk/v1';
import { MxcBroker } from '../mxc-broker';
import { mxcBackend } from '../windows-mxc';
import { SandboxStartError } from '../types';

const MISSING_NODE = join(tmpdir(), 'nodal-no-such-dir', 'node.exe');
const request = { command: 'exit 0' } as ContainerRequest;

/** La promesse se règle avant `ms`, ou le test échoue en le disant. */
function settled<T>(p: Promise<T>, ms = 5_000): Promise<{ ok: T } | { err: unknown }> {
  return Promise.race([
    p.then(
      (ok) => ({ ok }),
      (err: unknown) => ({ err }),
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`STILL PENDING after ${ms} ms`)), ms),
    ),
  ]);
}

describe('MxcBroker — a broker that cannot start leaves nothing pending @cap:executer-une-commande/moteur', () => {
  it('chaque ouverture en attente est rejetée avec SANDBOX_BROKER_START_FAILED et l’erreur de l’OS', async () => {
    const broker = new MxcBroker(__filename, MISSING_NODE);
    const [a, b] = await Promise.all([
      settled(broker.open(request)),
      settled(broker.open(request)),
    ]);
    for (const r of [a, b]) {
      expect('err' in r).toBe(true);
      const e = (r as { err: unknown }).err;
      expect(e).toBeInstanceOf(SandboxStartError);
      expect((e as SandboxStartError).message).toMatch(
        /^SANDBOX_START_FAILED: SANDBOX_BROKER_START_FAILED: ENOENT /,
      );
      expect((e as SandboxStartError).reasonCode).toBe('SANDBOX_BROKER_START_FAILED');
    }
  });

  it('une ouverture APRÈS l’échec relance le courtier et échoue de même, au lieu d’écrire à un processus mort', async () => {
    const broker = new MxcBroker(__filename, MISSING_NODE);
    await settled(broker.open(request));
    const again = await settled(broker.open(request));
    expect('err' in again && (again.err as Error).message).toMatch(/SANDBOX_BROKER_START_FAILED/);
  });

  it('un courtier lancé qui MEURT (ici : le SDK introuvable depuis `resolveFrom`) règle la même attente, avec SANDBOX_BROKER_EXITED et ce qu’il a écrit', async () => {
    // Le vrai script du courtier, sur le vrai Node : il résout le SDK depuis
    // un fichier à la racine du disque (aucun node_modules au-dessus), n'y
    // arrive pas, et s'arrête. NODE_PATH (posé par les lanceurs de pnpm) est
    // retiré le temps du lancement : il donnerait au courtier un autre
    // chemin vers le SDK.
    const nodePath = process.env['NODE_PATH'];
    delete process.env['NODE_PATH'];
    const broker = new MxcBroker(join(parse(tmpdir()).root, 'nodal-no-sdk-here', 'x.js'));
    let r: Awaited<ReturnType<typeof settled>>;
    try {
      r = await settled(broker.open(request), 20_000);
    } finally {
      if (nodePath !== undefined) process.env['NODE_PATH'] = nodePath;
    }
    expect('err' in r).toBe(true);
    const e = (r as { err: unknown }).err as SandboxStartError;
    expect(e).toBeInstanceOf(SandboxStartError);
    expect(e.message).toMatch(
      /^SANDBOX_START_FAILED: SANDBOX_BROKER_EXITED: .*@microsoft\/mxc-sdk/s,
    );
  }, 30_000);

  it('la somme ÉPINGLÉE du Node est vérifiée à CHAQUE lancement : un binaire changé entre deux lancements est écarté, rien n’est lancé (#628, P1-2)', async () => {
    // Un faux « node.exe » : la vérification passe avant `spawn`. Somme juste
    // → le lancement est TENTÉ (et échoue : ce n'est pas un exécutable, code
    // START_FAILED). Puis le fichier est réécrit : le lancement SUIVANT le
    // re-vérifie, l'écarte (supprimé) et ne lance rien (code NODE_UNAVAILABLE).
    const dir = mkdtempSync(join(tmpdir(), 'nodal-pin-'));
    const fake = join(dir, 'node.exe');
    writeFileSync(fake, 'not really node');
    const pin = createHash('sha256').update('not really node').digest('hex');
    try {
      const broker = new MxcBroker(__filename, fake, pin);
      const first = await settled(broker.open(request));
      const e1 = (first as { err: SandboxStartError }).err;
      // Le lancement a été TENTÉ : le système refuse ce faux binaire (une
      // erreur de lancement ou une sortie immédiate, selon l'OS) — pas un refus
      // de la somme.
      expect(e1.message, e1.message).toMatch(/SANDBOX_BROKER_(START_FAILED|EXITED)/);
      expect(e1.reasonCode).not.toBe('SANDBOX_BROKER_NODE_UNAVAILABLE');
      writeFileSync(fake, 'tampered between two launches');
      const second = await settled(broker.open(request));
      const e = (second as { err: SandboxStartError }).err;
      expect(e).toBeInstanceOf(SandboxStartError);
      expect(e.reasonCode).toBe('SANDBOX_BROKER_NODE_UNAVAILABLE');
      expect(e.message).toMatch(/not the pinned/);
      expect(existsSync(fake)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('écrire à / tuer un conteneur dont le courtier est MORT ne relance AUCUN courtier (seule une ouverture lance, et vérifie son Node)', async () => {
    // Un faux SDK, résolu par le vrai script du courtier depuis `resolveFrom` :
    // `spawn` rend un processus qui ne finit jamais. Aucun MXC requis.
    const dir = mkdtempSync(join(tmpdir(), 'nodal-fake-sdk-'));
    const sdkDir = join(dir, 'node_modules', '@microsoft', 'mxc-sdk');
    mkdirSync(sdkDir, { recursive: true });
    writeFileSync(
      join(sdkDir, 'package.json'),
      JSON.stringify({ name: '@microsoft/mxc-sdk', exports: { './v1': './v1.mjs' } }),
    );
    writeFileSync(
      join(sdkDir, 'v1.mjs'),
      'export async function spawn() { return { id: 4242, standardInput: null, standardOutput: null, standardError: null, wait: () => new Promise(() => {}), kill() {}, dispose() {} }; }\n',
    );
    const broker = new MxcBroker(join(dir, 'x.js'));
    const internals = broker as unknown as { child: ChildProcess | null };
    try {
      const c = await broker.open(request);
      expect(c.pid).toBe(4242);
      internals.child!.kill();
      const end = await settled(c.exited, 10_000);
      expect((end as { ok: { output: string } }).ok.output).toMatch(/SANDBOX_BROKER_EXITED/);
      expect(internals.child).toBeNull();
      c.write('late input\n');
      c.kill();
      expect(internals.child).toBeNull(); // rien relancé
    } finally {
      internals.child?.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('la sonde du backend rend `unavailable` avec le code SANDBOX_BROKER_START_FAILED', async () => {
    // Un SDK qui dit oui à tout : seul le lancement du courtier peut échouer.
    const sdk = {
      getPlatformSupport: () => ({
        isSupported: true,
        reason: '',
        availableMethods: ['processcontainer'],
        isolationTier: 'base-container',
      }),
      getAvailableBackends: () => [
        { backend: 'processcontainer', tier: 'base-container', capabilities: [], warnings: [] },
      ],
    };
    const backend = mxcBackend(() => Promise.resolve(sdk as never), 'deny-all', MISSING_NODE);
    const r = await settled(backend.probe());
    expect('ok' in r).toBe(true);
    const status = (r as { ok: Awaited<ReturnType<typeof backend.probe>> }).ok;
    expect(status.state).toBe('unavailable');
    if (status.state !== 'unavailable') return;
    expect(status.code).toBe('SANDBOX_BROKER_START_FAILED');
    expect(status.reason).toMatch(/^SANDBOX_BROKER_START_FAILED: ENOENT /);
  });
});

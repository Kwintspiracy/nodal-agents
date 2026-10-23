// spawn-turn-stop.test.ts — Stop tue le processus d'un tour CLI (#456).
//
// Un agent en runtime CLI (Claude Code, Codex) répond par un vrai processus.
// Sans ce fil, Stop laissait la CLI tourner jusqu'à son délai (10 min en chat)
// et exécuter ses outils. Ce qui se prouve ici, sur un VRAI processus : le
// Stop tue l'arbre et le tour rend la main bien avant le délai.

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProcessScope } from '@nodal-agents/sandbox';
import { watchProcess } from '@nodal-agents/test-kit';
import { spawnCliTurn } from '../../cli-runtime/spawn-turn.ts';

// La CLI tourne dans un périmètre de processus, comme dans un job (#750).
const scope = openProcessScope(`spawn-turn-test:${randomUUID()}`);
afterAll(() => scope.close());

describe('spawnCliTurn — Stop @cap:parler-a-un-agent/moteur', () => {
  it('tue un processus qui ne finirait jamais, dès le Stop', async () => {
    const stop = new AbortController();
    const started = Date.now();
    const turn = spawnCliTurn({
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      env: process.env,
      cwd: process.cwd(),
      stdin: '',
      processScope: scope,
      timeoutMs: 600_000,
      abortSignal: stop.signal,
      onLine: () => 0,
      finish: (o) => o,
    });

    setTimeout(() => stop.abort(), 200);
    const outcome = await turn;

    // Rendu bien avant le délai de 10 min : le Stop, pas l'expiration.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome.timedOut).toBe(false);
  }, 20_000);

  it('un Stop déjà tiré avant le lancement tue le processus aussitôt', async () => {
    const stop = new AbortController();
    stop.abort();
    const started = Date.now();

    const outcome = await spawnCliTurn({
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      env: process.env,
      cwd: process.cwd(),
      stdin: '',
      processScope: scope,
      timeoutMs: 600_000,
      abortSignal: stop.signal,
      onLine: () => 0,
      finish: (o) => o,
    });

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome.timedOut).toBe(false);
  }, 20_000);
});

// #750 : ce que la CLI laisse tourner (un serveur que son outil Bash a lancé en
// arrière-plan, détaché) vit au-delà du tour — le tour suivant du même job le
// joint — et meurt quand le périmètre du job se ferme.
describe('spawnCliTurn — what the CLI leaves running belongs to its job (#750) @cap:parler-a-un-agent/moteur', () => {
  it('a detached process the CLI started outlives the turn, then dies when the scope closes', async () => {
    const own = openProcessScope(`spawn-turn-leftover:${randomUUID()}`);
    const dir = mkdtempSync(join(tmpdir(), 'nodal-cli-leftover-'));
    const pidFile = join(dir, 'daemon.pid');
    const daemon =
      "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)";
    try {
      const outcome = await spawnCliTurn({
        argv: [
          process.execPath,
          '-e',
          `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(daemon)}, ${JSON.stringify(pidFile)}], { detached: true, stdio: 'ignore' }).unref()`,
        ],
        env: process.env,
        cwd: dir,
        stdin: '',
        processScope: own,
        timeoutMs: 30_000,
        onLine: () => 0,
        finish: (o) => o,
      });
      expect(outcome.exitCode).toBe(0);
      for (let i = 0; i < 200 && !existsSync(pidFile); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // Tenu dès que son pid est lu (#841) : le tuer ensuite ne peut atteindre
      // que lui, même si son pid avait été redonné.
      const daemonWatch = await watchProcess(Number(readFileSync(pidFile, 'utf8')));
      try {
        expect(daemonWatch.alive()).toBe(true);
        await own.close();
        let dead = false;
        for (let i = 0; i < 100 && !dead; i++) {
          dead = !daemonWatch.alive();
          if (!dead) await new Promise((r) => setTimeout(r, 50));
        }
        daemonWatch.kill();
        expect(dead).toBe(true);
      } finally {
        daemonWatch.release();
      }
    } finally {
      await own.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  }, 60_000);
});

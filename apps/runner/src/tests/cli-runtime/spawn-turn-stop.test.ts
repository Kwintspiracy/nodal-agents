// spawn-turn-stop.test.ts — Stop tue le processus d'un tour CLI (#456).
//
// Un agent en runtime CLI (Claude Code, Codex) répond par un vrai processus.
// Sans ce fil, Stop laissait la CLI tourner jusqu'à son délai (10 min en chat)
// et exécuter ses outils. Ce qui se prouve ici, sur un VRAI processus : le
// Stop tue l'arbre et le tour rend la main bien avant le délai.

import { describe, it, expect, afterAll, vi } from 'vitest';
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

// Le Stop doit finir le tour PAR LA MORT DU PROCESSUS, pas par l'expiration du
// délai de grâce (3 s) qui force la sortie. On le prouve sans durée (#960) :
// `setTimeout`/`clearTimeout` sont simulés et l'horloge n'avance JAMAIS, donc
// le délai de grâce et le délai du tour ne peuvent pas tomber ; le tour ne peut
// se régler que par l'événement de sortie du vrai processus. Un kill différé
// ou sans effet laisse le tour en suspens. Le signal exact (SIGTERM ou non)
// n'entre pas en jeu : sous Windows il n'y en a pas, et seul le fait compte.
// La seule durée est la borne côté ÉCHEC, qui évite d'attendre les 20 s de
// vitest quand le tour ne se règle pas ; elle n'est jamais atteinte sinon.
const realSetTimeout = globalThis.setTimeout;
const NEVER_SETTLED = Symbol('never-settled');
const FAILURE_BOUND_MS = 10_000;
const CHILD_SOURCE = 'console.log(process.pid); setInterval(() => {}, 1000)';

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('spawnCliTurn — Stop @cap:parler-a-un-agent/moteur', () => {
  it('tue un processus qui ne finirait jamais, dès le Stop', async () => {
    const stop = new AbortController();
    let pid: number | undefined;
    let markReady: () => void = () => {};
    const ready = new Promise<void>((r) => (markReady = r));
    // Le processus est lancé et vivant AVANT que l'horloge soit simulée.
    const turn = spawnCliTurn({
      argv: [process.execPath, '-e', CHILD_SOURCE],
      env: process.env,
      cwd: process.cwd(),
      stdin: '',
      processScope: scope,
      timeoutMs: 600_000,
      abortSignal: stop.signal,
      onLine: (line) => {
        pid = Number(line.trim());
        markReady();
      },
      finish: (o) => o,
    });
    await ready;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      stop.abort();
      const outcome = await Promise.race([
        turn,
        new Promise<typeof NEVER_SETTLED>((r) =>
          realSetTimeout(() => r(NEVER_SETTLED), FAILURE_BOUND_MS),
        ),
      ]);
      expect(outcome, 'le Stop n’a pas tué le processus : le tour ne s’est pas réglé').not.toBe(
        NEVER_SETTLED,
      );
      if (outcome === NEVER_SETTLED) return;
      // Rendu par le Stop, pas par l'expiration du délai de 10 min.
      expect(outcome.timedOut).toBe(false);
      expect(isAlive(pid ?? -1), 'le processus tourne encore').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('un Stop déjà tiré avant le lancement tue le processus aussitôt', async () => {
    const stop = new AbortController();
    stop.abort();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const outcome = await Promise.race([
        spawnCliTurn({
          argv: [process.execPath, '-e', CHILD_SOURCE],
          env: process.env,
          cwd: process.cwd(),
          stdin: '',
          processScope: scope,
          timeoutMs: 600_000,
          abortSignal: stop.signal,
          onLine: () => 0,
          finish: (o) => o,
        }),
        new Promise<typeof NEVER_SETTLED>((r) =>
          realSetTimeout(() => r(NEVER_SETTLED), FAILURE_BOUND_MS),
        ),
      ]);
      expect(outcome, 'le Stop n’a pas tué le processus : le tour ne s’est pas réglé').not.toBe(
        NEVER_SETTLED,
      );
      if (outcome === NEVER_SETTLED) return;
      expect(outcome.timedOut).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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

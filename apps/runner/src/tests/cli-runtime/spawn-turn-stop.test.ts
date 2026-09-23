// spawn-turn-stop.test.ts — Stop tue le processus d'un tour CLI (#456).
//
// Un agent en runtime CLI (Claude Code, Codex) répond par un vrai processus.
// Sans ce fil, Stop laissait la CLI tourner jusqu'à son délai (10 min en chat)
// et exécuter ses outils. Ce qui se prouve ici, sur un VRAI processus : le
// Stop tue l'arbre et le tour rend la main bien avant le délai.

import { describe, it, expect } from 'vitest';
import { spawnCliTurn } from '../../cli-runtime/spawn-turn.ts';

describe('spawnCliTurn — Stop @cap:parler-a-un-agent/moteur', () => {
  it('tue un processus qui ne finirait jamais, dès le Stop', async () => {
    const stop = new AbortController();
    const started = Date.now();
    const turn = spawnCliTurn({
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      env: process.env,
      cwd: process.cwd(),
      stdin: '',
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
      timeoutMs: 600_000,
      abortSignal: stop.signal,
      onLine: () => 0,
      finish: (o) => o,
    });

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome.timedOut).toBe(false);
  }, 20_000);
});

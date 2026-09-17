// turn-lane.test.ts — un tour à la fois par conversation.
//
// Ce qui se prouve : sur la même clé, le second travail ne COMMENCE qu'après
// la fin du premier ; un échec rend son erreur à son appelant et ne bloque pas
// le suivant ; deux clés ne s'attendent pas ; la file se vide toute seule.

import { describe, it, expect } from 'vitest';
import { runInLane, openLanes } from '../../chat/turn-lane.ts';

function gate(): { open: () => void; wait: Promise<void> } {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('runInLane — un tour à la fois par conversation @cap:parler-a-un-agent/moteur', () => {
  it('sur la même conversation, le second tour ne commence qu’après la fin du premier', async () => {
    const log: string[] = [];
    const first = gate();
    const a = runInLane('conv-1', async () => {
      log.push('a:start');
      await first.wait;
      log.push('a:end');
      return 'A';
    });
    const b = runInLane('conv-1', async () => {
      log.push('b:start');
      return 'B';
    });
    await tick();
    expect(log).toEqual(['a:start']);
    first.open();
    expect(await a).toBe('A');
    expect(await b).toBe('B');
    expect(log).toEqual(['a:start', 'a:end', 'b:start']);
    await tick();
    expect(openLanes()).toBe(0);
  });

  it('un tour qui échoue rend son erreur à son appelant et ne bloque pas le suivant', async () => {
    const a = runInLane('conv-2', async () => {
      throw new Error('model unreachable');
    });
    const b = runInLane('conv-2', async () => 'B');
    await expect(a).rejects.toThrow('model unreachable');
    expect(await b).toBe('B');
    await tick();
    expect(openLanes()).toBe(0);
  });

  it('deux conversations ne s’attendent pas', async () => {
    const log: string[] = [];
    const first = gate();
    const a = runInLane('conv-3', async () => {
      log.push('a:start');
      await first.wait;
      return 'A';
    });
    const b = runInLane('conv-4', async () => {
      log.push('b:start');
      return 'B';
    });
    await tick();
    expect(log).toEqual(['a:start', 'b:start']);
    // B a fini sans attendre A : sa file est déjà vidée, celle de A tient encore.
    expect(await b).toBe('B');
    expect(openLanes()).toBe(1);
    first.open();
    expect(await a).toBe('A');
    await tick();
    expect(openLanes()).toBe(0);
  });
});

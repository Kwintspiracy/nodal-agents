// call-clock.test.ts — the bound of ONE MCP tool call, once the call is over.
//
// Revue Codex passe 1 de #660 : quand le serveur rend son résultat pendant
// qu'une question est encore ouverte, `stop()` interrompt la question, qui se
// déroule ensuite et appelle `resume()`. Ce `resume()` réarmait la minuterie
// d'un appel déjà fini : une minuterie vivante par question, qui retient le
// processus et finit par interrompre un signal que plus personne n'écoute.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallClock } from '../tools.ts';

describe('CallClock @cap:connecter-un-service/moteur', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a call that is over never arms its timer again, whatever unwinds after it', () => {
    const clock = new CallClock(1_000, 'printer__request_print');
    clock.pause(); // a person is answering
    clock.stop(); // the server returned meanwhile
    clock.resume(); // the question unwinds
    clock.restart(); // a late progress notification
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(clock.controller.signal.aborted).toBe(false);
  });

  it('a running call still times out, paused while a person answers', () => {
    const clock = new CallClock(1_000, 'printer__request_print');
    clock.pause();
    vi.advanceTimersByTime(5_000);
    expect(clock.controller.signal.aborted).toBe(false);
    clock.resume();
    vi.advanceTimersByTime(1_000);
    expect(clock.controller.signal.aborted).toBe(true);
  });
});

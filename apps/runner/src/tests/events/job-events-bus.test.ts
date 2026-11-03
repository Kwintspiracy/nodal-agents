// job-events-bus.test.ts — le bus des événements de job (#944), seul.
//
// Ce qui se prouve ici, sur le vrai bus : ce qu'un client qui revient reçoit
// (ce qu'il a manqué, ou un `resync` qui dit pourquoi — jamais rien), et
// l'isolement des espaces, qui est une exigence dure : un client de A ne reçoit
// jamais un événement de B, ni en direct, ni en reprise.
//
// Le câblage des portes (un job fini publie, une question publie…) est prouvé
// par `job-events-flow.test.ts`, sur le vrai runner.

import { describe, it, expect } from 'vitest';
import { JobEventBus } from '../../events/job-events.ts';
import type { JobEventPayload, StoredJobEvent } from '../../events/job-events.ts';

const A = 'entity-a';
const B = 'entity-b';

const finished = (jobId: string, conversationId: string | null = null): JobEventPayload => ({
  type: 'job.finished',
  jobId,
  conversationId,
  parentJobId: null,
  status: 'completed',
  reply: `reply of ${jobId}`,
});

function listen(
  bus: JobEventBus,
  entityId: string,
  conversationId: string | null = null,
  lastEventId: string | null = null,
) {
  const received: StoredJobEvent[] = [];
  const sub = bus.open(entityId, conversationId, lastEventId, (e) => received.push(e));
  return { received, ...sub };
}

const jobIds = (events: readonly StoredJobEvent[]): string[] =>
  events.map((e) => (e.payload.type === 'job.finished' ? e.payload.jobId : e.payload.type));

describe('le bus des événements de job (#944) @cap:suivre-execution/moteur', () => {
  it('un abonné reçoit en direct les événements de son espace, et ceux-là seuls', () => {
    const bus = new JobEventBus();
    const a = listen(bus, A);
    const b = listen(bus, B);
    bus.publish(A, null, finished('job-a1'));
    bus.publish(B, null, finished('job-b1'));
    bus.publish(A, null, finished('job-a2'));
    expect(jobIds(a.received)).toEqual(['job-a1', 'job-a2']);
    expect(jobIds(b.received)).toEqual(['job-b1']);
  });

  it("chaque espace a son compteur : l'activité de B ne se lit pas dans les identifiants de A", () => {
    const bus = new JobEventBus({ bootId: 'boot' });
    bus.publish(B, null, finished('job-b1'));
    bus.publish(B, null, finished('job-b2'));
    const first = bus.publish(A, null, finished('job-a1'));
    expect(first.id).toBe('boot:1');
    expect(bus.headId(A)).toBe('boot:1');
  });

  it("un abonné d'une conversation ne reçoit que la sienne ; un abonné de l'espace reçoit tout", () => {
    const bus = new JobEventBus();
    const conv = listen(bus, A, 'conv-1');
    const all = listen(bus, A);
    bus.publish(A, 'conv-1', finished('job-1', 'conv-1'));
    bus.publish(A, 'conv-2', finished('job-2', 'conv-2'));
    bus.publish(A, null, finished('job-3'));
    expect(jobIds(conv.received)).toEqual(['job-1']);
    expect(jobIds(all.received)).toEqual(['job-1', 'job-2', 'job-3']);
  });

  it("un abonnement neuf ne rejoue rien et rend l'identifiant du dernier événement", () => {
    const bus = new JobEventBus({ bootId: 'boot' });
    bus.publish(A, null, finished('job-1'));
    const fresh = listen(bus, A);
    expect(fresh.opening).toEqual({ kind: 'fresh', headId: 'boot:1' });
    expect(fresh.received).toEqual([]);
  });

  it("revenir avec le dernier identifiant vu rejoue ce qui a été manqué, dans l'ordre, et rien d'autre", () => {
    const bus = new JobEventBus();
    const first = listen(bus, A, 'conv-1');
    bus.publish(A, 'conv-1', finished('job-1', 'conv-1'));
    const lastSeen = first.received.at(-1)!.id;
    first.close();
    bus.publish(A, 'conv-1', finished('job-2', 'conv-1'));
    bus.publish(A, 'conv-2', finished('job-other', 'conv-2'));
    bus.publish(B, 'conv-1', finished('job-b', 'conv-1'));
    bus.publish(A, 'conv-1', finished('job-3', 'conv-1'));

    const back = listen(bus, A, 'conv-1', lastSeen);
    expect(back.opening.kind).toBe('replay');
    if (back.opening.kind !== 'replay') return;
    expect(jobIds(back.opening.events)).toEqual(['job-2', 'job-3']);
  });

  it("revenir quand rien n'a été manqué rejoue une liste vide, pas un resync", () => {
    const bus = new JobEventBus();
    const ev = bus.publish(A, null, finished('job-1'));
    const back = listen(bus, A, null, ev.id);
    expect(back.opening).toEqual({ kind: 'replay', headId: ev.id, events: [] });
  });

  it("un identifiant d'un AUTRE runner (redémarré) rend un resync, jamais rien", () => {
    const before = new JobEventBus({ bootId: 'old' });
    const seen = before.publish(A, null, finished('job-1'));
    const after = new JobEventBus({ bootId: 'new' });
    const back = listen(after, A, null, seen.id);
    expect(back.opening).toEqual({ kind: 'resync', headId: 'new:0', reason: 'runner_restarted' });
  });

  it('un identifiant illisible, ou en avance sur le bus, rend un resync', () => {
    const bus = new JobEventBus({ bootId: 'boot' });
    bus.publish(A, null, finished('job-1'));
    expect(listen(bus, A, null, 'not-an-id').opening).toMatchObject({
      kind: 'resync',
      reason: 'unknown_cursor',
    });
    expect(listen(bus, A, null, 'boot:99').opening).toMatchObject({
      kind: 'resync',
      reason: 'unknown_cursor',
    });
  });

  it('ce qui est sorti de la mémoire rend un resync : une reprise partielle serait un silence', () => {
    const bus = new JobEventBus({ capacity: 3 });
    const seen = bus.publish(A, null, finished('job-1'));
    for (const id of ['job-2', 'job-3', 'job-4', 'job-5']) bus.publish(A, null, finished(id));
    // job-2 est sorti de la mémoire (elle garde 3, 4, 5).
    expect(listen(bus, A, null, seen.id).opening).toMatchObject({
      kind: 'resync',
      reason: 'cursor_too_old',
    });
    // Le curseur juste avant le plus ancien gardé, lui, se rejoue en entier.
    const atEdge = listen(bus, A, null, seen.id.replace(/:1$/, ':2'));
    expect(atEdge.opening.kind).toBe('replay');
    if (atEdge.opening.kind === 'replay') {
      expect(jobIds(atEdge.opening.events)).toEqual(['job-3', 'job-4', 'job-5']);
    }
  });

  it("la mémoire de B ne pousse pas celle de A dehors : la reprise d'un espace ne dépend pas d'un autre", () => {
    const bus = new JobEventBus({ capacity: 2 });
    const seen = bus.publish(A, null, finished('job-a1'));
    bus.publish(A, null, finished('job-a2'));
    for (let i = 0; i < 10; i++) bus.publish(B, null, finished(`job-b${i}`));
    const back = listen(bus, A, null, seen.id);
    expect(back.opening.kind).toBe('replay');
    if (back.opening.kind === 'replay') expect(jobIds(back.opening.events)).toEqual(['job-a2']);
  });

  it('un événement perdu (espace inconnu) dit resync à chaque espace, en direct ET en reprise', () => {
    const bus = new JobEventBus();
    const a = listen(bus, A, 'conv-1');
    const seenB = bus.publish(B, null, finished('job-b1'));
    bus.resyncEverywhere('event_lost');
    expect(a.received.map((e) => e.payload)).toEqual([{ type: 'resync', reason: 'event_lost' }]);
    // B n'écoutait pas : il revient, et apprend qu'il doit relire.
    expect(listen(bus, B, null, seenB.id).opening).toMatchObject({
      kind: 'resync',
      reason: 'event_lost',
    });
  });

  it('un abonné désinscrit ne reçoit plus rien, et un abonné qui lève ne prive pas les autres', () => {
    const bus = new JobEventBus();
    const gone = listen(bus, A);
    gone.close();
    bus.open(A, null, null, () => {
      throw new Error('reader left');
    });
    const ok = listen(bus, A);
    bus.publish(A, null, finished('job-1'));
    expect(gone.received).toEqual([]);
    expect(jobIds(ok.received)).toEqual(['job-1']);
  });
});

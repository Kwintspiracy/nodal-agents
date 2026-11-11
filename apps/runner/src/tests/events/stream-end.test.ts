// stream-end.test.ts — whatever ends a push stream removes its subscriber
// and ends its body, exactly once (#1033).
//
// The symptom (CI Windows, run 42781022369): the teardown of
// device-channel.test.ts aborted every stream it had opened and waited 60 s for
// one of them to end; the next test found that stream's subscriber still on
// the bus. Two paths left a subscriber there for good, each reproduced here
// without a sleep and without load:
//   1. the request's signal was ALREADY aborted when the stream opened (a
//      client gone while the route still authorised it): an `abort` listener
//      added to an aborted signal is never called, and `@hono/node-server`
//      only listens to the connection's close once it starts writing the
//      body, after that close;
//   2. the request was garbage-collected: the signal of a `Request` built
//      with a caller's signal only FOLLOWS it, and undici holds that link
//      weakly; once the request is collected, the caller's abort never
//      arrives. This is what a slow, GC-heavy run opened in the test.
// Every other end of the stream (abort after `ready`, abort in the middle of
// a write, the reader cancelling, the reader gone during the replay) is
// proven on the same streams, for two devices and a workspace listener, so
// the fix holds for every way in, not only for the ones that failed.

import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest, type ClientRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { JobEventBus, type JobEventPayload, type StoredJobEvent } from '../../events/job-events.ts';
import { streamJobEvents } from '../../routes/events.ts';
import { subscriptionStream } from '../../routes/sse.ts';
import { readSse, type SseEvent } from '../chat/_sse-reader.ts';

// Le ramasse-miettes, à la demande : c'est lui qui défaisait le lien entre le
// signal de l'appelant et celui de la requête.
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

const X = 'entity-x';
const DEVICE_A = 'device-a';
const DEVICE_B = 'device-b';
/** Un appareil, un autre appareil, et un client de tout l'espace (le tableau de bord). */
const LISTENERS: Array<string | null> = [DEVICE_A, DEVICE_B, null];

const finished = (jobId: string): JobEventPayload => ({
  type: 'job.finished',
  jobId,
  conversationId: null,
  parentJobId: null,
  status: 'completed',
  reply: `reply of ${jobId}`,
});

/** Publish what reaches each listener: one job of each device, one of nobody's. */
function publishToEveryone(bus: JobEventBus, tag: string): void {
  bus.publish(X, null, finished(`${tag}-a`), DEVICE_A);
  bus.publish(X, null, finished(`${tag}-b`), DEVICE_B);
  bus.publish(X, null, finished(`${tag}-none`), null);
}

/** Who is still on the bus, for each kind of listener. */
function stillListening(bus: JobEventBus): Record<string, number> {
  return {
    total: bus.subscriberCount(X),
    [DEVICE_A]: bus.listenersOf(X, null, DEVICE_A),
    [DEVICE_B]: bus.listenersOf(X, null, DEVICE_B),
  };
}
const NOBODY = { total: 0, [DEVICE_A]: 0, [DEVICE_B]: 0 };

/** The streams' routes. `beforeOpen` stands for the route's own work before the stream (the guard's lookup). */
function appFor(bus: JobEventBus, hooks: Hooks) {
  const app = new Hono();
  app.get('/stream', async (c) => {
    await hooks.beforeOpen(c.req.raw);
    const deviceId = c.req.query('device') ?? null;
    const res = streamJobEvents(
      c,
      bus,
      { entityId: X, conversationId: null, deviceId },
      null,
      (e) => {
        hooks.onRender(e, deviceId);
        return [{ event: e.payload.type, data: e.payload }];
      },
    );
    hooks.onOpened(deviceId);
    return res;
  });
  return app;
}
interface Hooks {
  beforeOpen: (request: Request) => Promise<void>;
  /** Called while the stream of `deviceId` renders `e`, before it writes it. */
  onRender: (e: StoredJobEvent, deviceId: string | null) => void;
  /** The route has opened its stream. */
  onOpened: (deviceId: string | null) => void;
}
const noHooks = (): Hooks => ({
  beforeOpen: async () => {},
  onRender: () => {},
  onOpened: () => {},
});

const pathOf = (deviceId: string | null) =>
  deviceId === null ? '/stream' : `/stream?device=${deviceId}`;

/**
 * Opens a stream through `app.fetch`, as a test or any embedder does: the
 * Request is built inline and nothing here keeps it.
 */
async function open(
  app: Hono,
  deviceId: string | null,
  ctl = new AbortController(),
): Promise<{ ctl: AbortController; events: SseEvent[]; done: Promise<void> }> {
  const res = await app.fetch(
    new Request(`http://localhost${pathOf(deviceId)}`, { signal: ctl.signal }),
  );
  expect(res.status).toBe(200);
  const reader = readSse(res);
  // Ce que le flux a déjà écrit (son `ready`) est lu avant de rendre la main.
  await turns(10);
  return { ctl, events: reader.events, done: reader.done };
}

type Opened = Awaited<ReturnType<typeof open>>;

/**
 * Whether a body has ended, once the event loop has had a few turns to carry
 * the close to the reader. A body that has not ended by then is still open:
 * nothing else is pending.
 */
async function hasEnded(done: Promise<void>): Promise<boolean> {
  let ended = false;
  void done.then(() => {
    ended = true;
  });
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
  return ended;
}

async function turns(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
}

describe('a push stream ends with its request, whatever ends it (#1033) @cap:parler-par-canal-externe/moteur', () => {
  it('a request ALREADY aborted when its stream opens leaves no subscriber, and its body ends', async () => {
    const bus = new JobEventBus();
    const app = appFor(bus, noHooks());
    for (const deviceId of LISTENERS) {
      const ctl = new AbortController();
      ctl.abort();
      const s = await open(app, deviceId, ctl);
      expect(await hasEnded(s.done)).toBe(true);
    }
    expect(stillListening(bus)).toEqual(NOBODY);
    // Ce qui est publié ensuite n'atteint personne, et ne lève pas.
    publishToEveryone(bus, 'after');
    expect(stillListening(bus)).toEqual(NOBODY);
  });

  it('a request aborted WHILE the route still works before the stream (the guard) leaves no subscriber', async () => {
    const bus = new JobEventBus();
    let abortNow: () => void = () => {};
    const app = appFor(bus, {
      ...noHooks(),
      // Le client s'en va pendant que la route travaille encore.
      beforeOpen: async () => abortNow(),
    });
    for (const deviceId of LISTENERS) {
      const ctl = new AbortController();
      abortNow = () => ctl.abort();
      const s = await open(app, deviceId, ctl);
      expect(await hasEnded(s.done)).toBe(true);
    }
    expect(stillListening(bus)).toEqual(NOBODY);
  });

  it('streams aborted after `ready`, before any event, each leave the bus and end, and only their own', async () => {
    const bus = new JobEventBus();
    const app = appFor(bus, noHooks());
    const streams: Opened[] = [];
    for (const deviceId of LISTENERS) streams.push(await open(app, deviceId));
    for (const s of streams) expect(s.events.map((e) => e.event)).toEqual(['ready']);
    expect(stillListening(bus)).toEqual({ total: 3, [DEVICE_A]: 2, [DEVICE_B]: 2 });

    // Le premier appareil s'en va : lui seul quitte le bus.
    streams[0]!.ctl.abort();
    expect(await hasEnded(streams[0]!.done)).toBe(true);
    expect(stillListening(bus)).toEqual({ total: 2, [DEVICE_A]: 1, [DEVICE_B]: 2 });
    publishToEveryone(bus, 'one');
    await turns(10);
    expect(streams[1]!.events.map((e) => e.event)).toEqual(['ready', 'job.finished']);
    expect(await hasEnded(streams[1]!.done)).toBe(false);

    for (const s of streams.slice(1)) s.ctl.abort();
    for (const s of streams) expect(await hasEnded(s.done)).toBe(true);
    expect(stillListening(bus)).toEqual(NOBODY);
  });

  it('a request aborted in the MIDDLE of a write: the subscriber is gone, nothing is written after, the body ends', async () => {
    const bus = new JobEventBus();
    const hooks = noHooks();
    const app = appFor(bus, hooks);
    const streams: Opened[] = [];
    for (const deviceId of LISTENERS) streams.push(await open(app, deviceId));
    // Chaque flux est abandonné pendant qu'il écrit son premier événement.
    const ctlOf = new Map(LISTENERS.map((d, i) => [d, streams[i]!.ctl]));
    hooks.onRender = (_e, deviceId) => ctlOf.get(deviceId)!.abort();
    publishToEveryone(bus, 'mid');
    expect(stillListening(bus)).toEqual(NOBODY);
    publishToEveryone(bus, 'after');
    for (const s of streams) {
      expect(await hasEnded(s.done)).toBe(true);
      expect(s.events.map((e) => e.event)).toEqual(['ready']);
    }
  });

  it('a request garbage-collected before its abort: the abort still ends the stream and frees the bus', async () => {
    const bus = new JobEventBus();
    const app = appFor(bus, noHooks());
    const streams: Opened[] = [];
    for (const deviceId of LISTENERS) streams.push(await open(app, deviceId));
    expect(stillListening(bus).total).toBe(3);
    // Plus personne ne tient les requêtes, sinon le flux lui-même.
    for (let i = 0; i < 5; i++) {
      gc();
      await turns(2);
    }
    for (const s of streams) s.ctl.abort();
    for (const s of streams) expect(await hasEnded(s.done)).toBe(true);
    expect(stillListening(bus)).toEqual(NOBODY);
  });

  it('a reader that cancels the body leaves no subscriber', async () => {
    const bus = new JobEventBus();
    const app = appFor(bus, noHooks());
    for (const deviceId of LISTENERS) {
      const res = await app.fetch(new Request(`http://localhost${pathOf(deviceId)}`));
      await res.body!.cancel();
    }
    expect(stillListening(bus)).toEqual(NOBODY);
    publishToEveryone(bus, 'after');
    expect(stillListening(bus)).toEqual(NOBODY);
  });
});

describe('over real HTTP (@hono/node-server), a client gone ends its stream (#1033) @cap:parler-par-canal-externe/moteur', () => {
  let server: ServerType | null = null;
  const clients: ClientRequest[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    const s = server;
    server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  });

  async function listen(app: Hono): Promise<number> {
    return new Promise((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) =>
        resolve(info.port),
      );
    });
  }

  async function waitUntil(check: () => boolean, label: string): Promise<void> {
    // Une condition, pas une durée : on rend la main à la boucle jusqu'à ce
    // qu'elle soit vraie ; la borne ne sert qu'à dire ce qui manque.
    for (let i = 0; i < 300; i++) {
      if (check()) return;
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    throw new Error(`waitUntil: ${label}`);
  }

  it('a client gone while the route still authorises: no subscriber stays, for each device and the workspace', async () => {
    const bus = new JobEventBus();
    const entered: Array<() => void> = [];
    let opened = 0;
    const app = appFor(bus, {
      ...noHooks(),
      onOpened: () => {
        opened++;
      },
      // La route ne finit son travail qu'APRÈS le départ du client : le
      // serveur a vu la connexion se fermer avant que le flux existe.
      beforeOpen: (request) =>
        new Promise<void>((resolve) => {
          entered.shift()?.();
          request.signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    const port = await listen(app);
    for (const deviceId of LISTENERS) {
      const inHandler = new Promise<void>((r) => entered.push(r));
      const req = httpRequest({ host: '127.0.0.1', port, path: pathOf(deviceId) });
      req.on('error', () => {});
      clients.push(req);
      req.end();
      await inHandler;
      req.destroy();
    }
    // Le flux de chacun s'est ouvert après le départ : rien ne doit y rester,
    // même quand le bus publie.
    await waitUntil(() => opened === LISTENERS.length, 'every stream opened');
    publishToEveryone(bus, 'after-1');
    publishToEveryone(bus, 'after-2');
    await waitUntil(
      () => bus.subscriberCount(X) === 0,
      `subscribers left: ${JSON.stringify(stillListening(bus))}`,
    );
    expect(stillListening(bus)).toEqual(NOBODY);
  });

  it('clients gone after `ready`: each subscriber leaves, the others keep listening', async () => {
    const bus = new JobEventBus();
    const app = appFor(bus, noHooks());
    const port = await listen(app);
    const received = new Map<string | null, string>();
    for (const deviceId of LISTENERS) {
      received.set(deviceId, '');
      const req = httpRequest({ host: '127.0.0.1', port, path: pathOf(deviceId) });
      req.on('error', () => {});
      req.on('response', (res) => {
        res.on('data', (chunk: Buffer) =>
          received.set(deviceId, received.get(deviceId) + chunk.toString()),
        );
        res.on('error', () => {});
      });
      clients.push(req);
      req.end();
      await waitUntil(
        () => received.get(deviceId)!.includes('event: ready'),
        `ready for ${deviceId}`,
      );
    }
    expect(stillListening(bus)).toEqual({ total: 3, [DEVICE_A]: 2, [DEVICE_B]: 2 });
    clients[0]!.destroy();
    await waitUntil(() => bus.listenersOf(X, null, DEVICE_A) === 1, 'device A gone');
    expect(stillListening(bus)).toEqual({ total: 2, [DEVICE_A]: 1, [DEVICE_B]: 2 });
    for (const c of clients.slice(1)) c.destroy();
    await waitUntil(() => bus.subscriberCount(X) === 0, 'everyone gone');
    expect(stillListening(bus)).toEqual(NOBODY);
  });
});

describe('subscriptionStream, the end path every subscribing SSE route shares (#1033) @cap:parler-par-canal-externe/moteur', () => {
  /** A source like the bus: a set of readers, and what each end did. */
  function source() {
    const readers = new Set<(chunk: string) => void>();
    const unsubscribed: string[] = [];
    return { readers, unsubscribed };
  }

  it('every way to end it, in any order, unsubscribes ONCE and closes the body', async () => {
    const orders: Array<Array<'abort' | 'cancel' | 'end'>> = [
      ['abort', 'cancel', 'end'],
      ['cancel', 'abort', 'end'],
      ['end', 'abort', 'cancel'],
    ];
    for (const order of orders) {
      const src = source();
      const ctl = new AbortController();
      let endIt: () => void = () => {};
      const stream = subscriptionStream(
        new Request('http://localhost/', { signal: ctl.signal }),
        (io) => {
          src.readers.add(io.write);
          endIt = io.end;
          return () => {
            src.readers.delete(io.write);
            src.unsubscribed.push(order.join('>'));
          };
        },
      );
      const reader = stream.getReader();
      const closed = reader.closed.then(() => {});
      for (const step of order) {
        if (step === 'abort') ctl.abort();
        if (step === 'cancel') await reader.cancel();
        if (step === 'end') endIt();
      }
      expect(src.readers.size).toBe(0);
      expect(src.unsubscribed).toEqual([order.join('>')]);
      expect(await hasEnded(closed)).toBe(true);
    }
  });

  it('a subscription that ends itself while opening is unsubscribed, and its body ends with what it wrote', async () => {
    const src = source();
    const stream = subscriptionStream(new Request('http://localhost/'), (io) => {
      src.readers.add(io.write);
      io.write('event: done\ndata: {}\n\n');
      io.end();
      return () => {
        src.readers.delete(io.write);
        src.unsubscribed.push('closed');
      };
    });
    const reader = readSse(new Response(stream));
    expect(await hasEnded(reader.done)).toBe(true);
    expect(reader.events.map((e) => e.event)).toEqual(['done']);
    expect(src.readers.size).toBe(0);
    expect(src.unsubscribed).toEqual(['closed']);
  });
});

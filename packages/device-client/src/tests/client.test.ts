// client.test.ts — the device client against a scripted Nodal (#950).
//
// Each case drives the public API (`pair`, `connect`, the gestures) and asserts
// on what reaches Nodal (the requests, their bodies and headers) and on what
// the device is handed (events, results, errors).
//
// Mutations verified (each turns at least one case red):
//   - `Last-Event-ID` not sent on reconnect → "replays the card missed";
//   - a 401 on the stream retried like a network drop → "a refused token ends";
//   - the idle timer not re-armed by the ping → "a ping keeps the stream";
//   - base64 audio passed through undecoded → "say: the reply's voice";
//   - `refused` treated as pending → "a refused pairing".

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_GESTURES, DEVICE_PROTOCOL_VERSION } from '@nodal-agents/shared';
import {
  connect,
  NodalDeviceError,
  pair,
  readSse,
  type NodalDeviceEvents,
} from '../nodal-device.ts';
import { fakeNodal, liveStream, sseBody, until, type LiveStream } from './fake-nodal.ts';

const BASE = 'http://nodal.test:3001/';
const DEVICE = '9b1f3c1e-6a43-4f53-9a43-1f2d3c4b5a69';
const ENTITY = '2c1d0e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const AGENT = '7e6d5c4b-3a29-4180-9f8e-7d6c5b4a3928';
const CONV = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d';
const CARD = '1f2e3d4c-5b6a-4798-8a7b-6c5d4e3f2a1b';
const TOKEN = `ndv_${'A'.repeat(43)}`;
const session = { deviceId: DEVICE, token: TOKEN, conversationId: CONV };

const conversationRoute = () =>
  Response.json({ entityId: ENTITY, agentId: AGENT, conversationId: CONV });

afterEach(() => {
  vi.useRealTimers();
});

function collect<K extends keyof NodalDeviceEvents>(
  nodal: { on: (t: K, h: (e: NodalDeviceEvents[K]) => void) => () => void },
  type: K,
): NodalDeviceEvents[K][] {
  const out: NodalDeviceEvents[K][] = [];
  nodal.on(type, (e) => out.push(e));
  return out;
}

describe('readSse: the event stream format @cap:parler-par-canal-externe/moteur', () => {
  it('reads events split anywhere, CRLF included, with comments, multi-line data and resume ids', async () => {
    const enc = new TextEncoder();
    const wire = [
      ': ping\r\n\r\nid: e1\r\nevent: card\r',
      '\ndata: {"a":',
      '1}\r\n\r\nevent: bubble\ndata: line one\ndata: line two\n\n',
      'id: e2\ndata: {}\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const w of wire) c.enqueue(enc.encode(w));
        c.close();
      },
    });
    const got = [];
    for await (const m of readSse(body)) got.push(m);
    expect(got).toEqual([
      { event: 'card', data: '{"a":1}', lastEventId: 'e1' },
      { event: 'bubble', data: 'line one\nline two', lastEventId: 'e1' },
      { event: 'message', data: '{}', lastEventId: 'e2' },
    ]);
  });
});

describe('pair(): from the device side @cap:parler-par-canal-externe/moteur', () => {
  it('asks with its name, capabilities and protocol version, then waits for the owner and gets its session', async () => {
    let polls = 0;
    const nodal = fakeNodal({
      'POST /api/devices/pair': () =>
        Response.json(
          {
            pairingId: 'p1',
            deviceCode: 'secret-device-code',
            userCode: '482913',
            expiresInSeconds: 600,
            intervalSeconds: 0,
          },
          { status: 201 },
        ),
      'POST /api/devices/pair/poll': () =>
        ++polls < 3
          ? Response.json({ status: 'pending' }, { status: 202 })
          : Response.json({
              status: 'paired',
              deviceId: DEVICE,
              token: TOKEN,
              conversationId: CONV,
            }),
    });
    const pairing = await pair(BASE, {
      name: 'Living room speaker',
      capabilities: ['microphone', 'speaker'],
      fetch: nodal.fetch,
    });
    expect(pairing.userCode).toBe('482913');
    expect(await pairing.done()).toEqual(session);
    expect(nodal.requests[0]).toMatchObject({
      method: 'POST',
      path: '/api/devices/pair',
      body: {
        name: 'Living room speaker',
        capabilities: ['microphone', 'speaker'],
        protocolVersion: DEVICE_PROTOCOL_VERSION,
      },
    });
    // The secret device code is what it polls with; no poll carries a token.
    expect(nodal.requests.slice(1).map((r) => r.body)).toEqual([
      { deviceCode: 'secret-device-code' },
      { deviceCode: 'secret-device-code' },
      { deviceCode: 'secret-device-code' },
    ]);
    expect(nodal.requests.every((r) => r.headers['authorization'] === undefined)).toBe(true);
  });

  it('slows down when told to, and waits the interval Nodal gives', async () => {
    vi.useFakeTimers();
    const at: number[] = [];
    let polls = 0;
    const nodal = fakeNodal({
      'POST /api/devices/pair': () =>
        Response.json(
          {
            pairingId: 'p1',
            deviceCode: 'dc',
            userCode: '000111',
            expiresInSeconds: 600,
            intervalSeconds: 2,
          },
          { status: 201 },
        ),
      'POST /api/devices/pair/poll': () => {
        at.push(Date.now());
        polls++;
        if (polls === 1) return Response.json({ status: 'slow_down' }, { status: 429 });
        return Response.json({
          status: 'paired',
          deviceId: DEVICE,
          token: TOKEN,
          conversationId: CONV,
        });
      },
    });
    const start = Date.now();
    const pairing = await pair(BASE, { name: 'x', capabilities: [], fetch: nodal.fetch });
    const done = pairing.done();
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(7000);
    expect(await done).toEqual(session);
    expect(at.map((t) => t - start)).toEqual([2000, 9000]);
  });

  it('a refused pairing throws `refused` and yields no session', async () => {
    const nodal = fakeNodal({
      'POST /api/devices/pair': () =>
        Response.json(
          {
            pairingId: 'p',
            deviceCode: 'dc',
            userCode: '123456',
            expiresInSeconds: 600,
            intervalSeconds: 0,
          },
          { status: 201 },
        ),
      'POST /api/devices/pair/poll': () => Response.json({ status: 'refused' }, { status: 403 }),
    });
    const pairing = await pair(BASE, { name: 'x', capabilities: [], fetch: nodal.fetch });
    const err = await pairing.done().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodalDeviceError);
    expect((err as NodalDeviceError).code).toBe('refused');
    expect((err as Error).message).toMatch(/^refused/);
  });

  it('an expired code throws `expired`', async () => {
    const nodal = fakeNodal({
      'POST /api/devices/pair': () =>
        Response.json(
          {
            pairingId: 'p',
            deviceCode: 'dc',
            userCode: '123456',
            expiresInSeconds: 600,
            intervalSeconds: 0,
          },
          { status: 201 },
        ),
      'POST /api/devices/pair/poll': () => Response.json({ status: 'expired' }, { status: 410 }),
    });
    const pairing = await pair(BASE, { name: 'x', capabilities: [], fetch: nodal.fetch });
    await expect(pairing.done()).rejects.toMatchObject({ code: 'expired', status: 410 });
  });

  it('a rate-limited request says so, with Nodal’s status', async () => {
    const nodal = fakeNodal({
      'POST /api/devices/pair': () => Response.json({ error: 'rate_limited' }, { status: 429 }),
    });
    await expect(
      pair(BASE, { name: 'x', capabilities: [], fetch: nodal.fetch }),
    ).rejects.toMatchObject({
      code: 'request_failed',
      status: 429,
      serverCode: 'rate_limited',
    });
  });
});

describe('connect(): the event stream @cap:parler-par-canal-externe/moteur', () => {
  it('hands each protocol event to its handler, with the token on the request', async () => {
    const live = liveStream();
    const nodal = fakeNodal({ 'GET /api/devices/:id/events': () => live.response });
    const device = connect(BASE, session, { fetch: nodal.fetch, hearAnnouncements: false });
    const cards = collect(device, 'card');
    const bubbles = collect(device, 'bubble');
    const states = collect(device, 'state');
    const card = {
      type: 'card',
      cardId: CARD,
      kind: 'question',
      text: '❓ Which room?',
      choices: [{ label: 'Kitchen', decision: 'approve', answer: 'Kitchen' }],
    };
    live.send('ready', {}, 'e0');
    live.send('card', card, 'e1');
    live.send(
      'state',
      { type: 'state', jobId: 'j1', conversationId: CONV, state: 'waiting' },
      'e2',
    );
    live.send(
      'bubble',
      { type: 'bubble', bubbleId: 'b', jobId: 'j1', conversationId: CONV, text: 'Done.' },
      'e3',
    );
    await until(() => bubbles.length === 1);
    expect(cards).toEqual([card]);
    expect(states.map((s) => s.state)).toEqual(['waiting']);
    expect(bubbles[0]!.text).toBe('Done.');
    expect(nodal.requests[0]).toMatchObject({
      method: 'GET',
      path: `/api/devices/${DEVICE}/events`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    device.close();
  });

  it('reconnects by itself after a network drop and replays the card it missed, from its last event id', async () => {
    const streams: LiveStream[] = [];
    const nodal = fakeNodal({
      'GET /api/devices/:id/events': () => {
        const s = liveStream();
        streams.push(s);
        return s.response;
      },
    });
    const device = connect(BASE, session, {
      fetch: nodal.fetch,
      hearAnnouncements: false,
      backoff: { initialMs: 5, maxMs: 20 },
    });
    const cards = collect(device, 'card');
    const ready = collect(device, 'ready');
    const drops = collect(device, 'disconnected');
    await until(() => streams.length === 1);
    streams[0]!.send('ready', {}, 'e4');
    streams[0]!.send(
      'state',
      { type: 'state', jobId: 'j', conversationId: CONV, state: 'waiting' },
      'e5',
    );
    await until(() => ready.length === 1);
    streams[0]!.drop();
    await until(() => streams.length === 2);
    // The runner replays from the id the client gives back: the card raised
    // while the device was away comes first, then `ready`.
    const card = { type: 'card', cardId: CARD, kind: 'approval', text: 'Approve?', choices: [] };
    streams[1]!.send('card', card, 'e6');
    streams[1]!.send('ready', {}, 'e6');
    await until(() => ready.length === 2);
    expect(nodal.requests.map((r) => r.headers['last-event-id'] ?? null)).toEqual([null, 'e5']);
    expect(cards).toEqual([card]);
    expect(ready).toEqual([{ reconnected: false }, { reconnected: true }]);
    expect(drops).toHaveLength(1);
    device.close();
    expect(streams[1]!.closed).toBe(true);
  });

  it('a stream that goes silent (no ping) is reopened; a ping keeps it', async () => {
    const streams: LiveStream[] = [];
    const nodal = fakeNodal({
      'GET /api/devices/:id/events': () => {
        const s = liveStream();
        streams.push(s);
        return s.response;
      },
    });
    const device = connect(BASE, session, {
      fetch: nodal.fetch,
      hearAnnouncements: false,
      idleTimeoutMs: 80,
      backoff: { initialMs: 5, maxMs: 5 },
    });
    await until(() => streams.length === 1);
    streams[0]!.send('ready', {}, 'e1');
    // Pings every 30 ms for 200 ms: the stream stays the same one.
    for (let i = 0; i < 7; i++) {
      await new Promise((r) => setTimeout(r, 30));
      streams[0]!.ping();
    }
    expect(streams).toHaveLength(1);
    // Then silence: a half-open connection. It is reopened, from e1.
    await until(() => streams.length === 2, 1000);
    expect(nodal.requests[1]!.headers['last-event-id']).toBe('e1');
    device.close();
  });

  it('passes `resync` on: what was missed must be re-read', async () => {
    const live = liveStream();
    const nodal = fakeNodal({ 'GET /api/devices/:id/events': () => live.response });
    const device = connect(BASE, session, { fetch: nodal.fetch });
    const resync = collect(device, 'resync');
    live.send('resync', { type: 'resync', reason: 'runner_restarted' }, 'h1');
    await until(() => resync.length === 1);
    expect(resync).toEqual([{ reason: 'runner_restarted' }]);
    device.close();
  });

  it('a refused token ends the session with `revoked`: no retry, and every gesture after says so', async () => {
    const streams: LiveStream[] = [];
    let refuse = false;
    const nodal = fakeNodal({
      'GET /api/devices/:id/events': () => {
        if (refuse) return Response.json({ error: 'device_token_invalid' }, { status: 401 });
        const s = liveStream();
        streams.push(s);
        return s.response;
      },
    });
    const device = connect(BASE, session, {
      fetch: nodal.fetch,
      backoff: { initialMs: 5, maxMs: 5 },
    });
    const closed = collect(device, 'closed');
    await until(() => streams.length === 1);
    streams[0]!.send('ready', {}, 'e1');
    // The owner removes the device: the runner closes its stream, then refuses the token.
    refuse = true;
    streams[0]!.end();
    await until(() => closed.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(nodal.requests.filter((r) => r.path.endsWith('/events'))).toHaveLength(2);
    expect(closed[0]!.error).toMatchObject({
      code: 'revoked',
      status: 401,
      serverCode: 'device_token_invalid',
    });
    await expect(device.send('hello')).rejects.toMatchObject({ code: 'revoked' });
  });

  it('a 401 on a gesture ends the session too', async () => {
    const live = liveStream();
    const nodal = fakeNodal({
      'GET /api/devices/:id/events': () => live.response,
      'POST /api/devices/:id/conversation': () =>
        Response.json({ error: 'device_token_invalid' }, { status: 401 }),
    });
    const device = connect(BASE, session, { fetch: nodal.fetch });
    const closed = collect(device, 'closed');
    await expect(device.send('hello')).rejects.toMatchObject({ code: 'revoked', status: 401 });
    expect(closed.map((c) => c.error.code)).toEqual(['revoked']);
    expect(live.closed).toBe(true);
  });
});

describe('say(): one spoken turn, its voice as speech events @cap:parler-par-canal-externe/moteur', () => {
  const PCM = Uint8Array.from({ length: 10 }, (_, i) => i * 7);
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

  function voiceNodal(end: () => Response) {
    const live = liveStream();
    const uploads: Uint8Array[] = [];
    const nodal = fakeNodal({
      'GET /api/devices/:id/events': () => live.response,
      'POST /api/devices/:id/conversation': conversationRoute,
      'POST /api/voice/turns': () => Response.json({ turnId: 'turn-1' }, { status: 201 }),
      'POST /api/voice/turns/:t/chunks/:seq': (r) => {
        uploads.push(r.bytes!);
        return Response.json({ received: uploads.length });
      },
      'POST /api/voice/turns/:t/end': end,
    });
    return { nodal, uploads, live };
  }

  it('uploads the audio in order, then hands the reply’s voice over as speech events, and resolves with the turn', async () => {
    const wav = Uint8Array.from({ length: 2500 }, (_, i) => i % 256);
    const { nodal, uploads } = voiceNodal(() =>
      sseBody([
        ['transcript', { transcript: 'Turn the lights on', durationMs: 1200 }],
        ['delta', { text: 'Sure, ' }],
        [
          'audio',
          {
            seq: 0,
            sentence: 0,
            mimeType: 'audio/pcm',
            sampleRate: 24000,
            base64: b64(PCM.subarray(0, 6)),
          },
        ],
        [
          'audio',
          {
            seq: 1,
            sentence: 0,
            mimeType: 'audio/pcm',
            sampleRate: 24000,
            base64: b64(PCM.subarray(6)),
          },
        ],
        ['audio_end', { sentence: 0, complete: true }],
        [
          'done',
          {
            reply: 'Sure, I started it.',
            spawnedJobId: 'job-9',
            streamed: true,
            stopped: false,
            cutReason: null,
            speechError: null,
          },
        ],
      ]),
    );
    const device = connect(BASE, session, { fetch: nodal.fetch, chunkBytes: 1000 });
    const speech = collect(device, 'speech');
    const result = await device.say(wav, 'audio/wav');

    expect(result).toEqual({
      transcript: 'Turn the lights on',
      reply: 'Sure, I started it.',
      spawnedJobId: 'job-9',
      stopped: false,
      speechError: null,
    });
    const start = nodal.requests.find((r) => r.path === '/api/voice/turns')!;
    expect(start.body).toEqual({ entityId: ENTITY, conversationId: CONV, format: 'audio/wav' });
    expect(nodal.requests.filter((r) => r.path.includes('/chunks/')).map((r) => r.path)).toEqual([
      '/api/voice/turns/turn-1/chunks/0',
      '/api/voice/turns/turn-1/chunks/1',
      '/api/voice/turns/turn-1/chunks/2',
    ]);
    expect(Uint8Array.from(uploads.flatMap((u) => [...u]))).toEqual(wav);

    const origin = { kind: 'turn', turnId: 'turn-1' };
    expect(speech).toEqual([
      {
        type: 'audio',
        origin,
        seq: 0,
        sentence: 0,
        mimeType: 'audio/pcm',
        sampleRate: 24000,
        audio: PCM.subarray(0, 6),
      },
      {
        type: 'audio',
        origin,
        seq: 1,
        sentence: 0,
        mimeType: 'audio/pcm',
        sampleRate: 24000,
        audio: PCM.subarray(6),
      },
      { type: 'sentence.end', origin, sentence: 0, complete: true },
      { type: 'end', origin, text: 'Sure, I started it.', error: null },
    ]);
    device.close();
  });

  it('PCM announces its sample rate; nothing heard resolves with no transcript and no voice', async () => {
    const { nodal } = voiceNodal(() =>
      sseBody([['nothing_heard', { durationMs: 300, model: 'm' }]]),
    );
    const device = connect(BASE, session, { fetch: nodal.fetch });
    const speech = collect(device, 'speech');
    const result = await device.say(PCM, 'audio/pcm', { sampleRate: 16000 });
    expect(result).toEqual({
      transcript: null,
      reply: null,
      spawnedJobId: null,
      stopped: false,
      speechError: null,
    });
    expect(speech).toEqual([]);
    expect(nodal.requests.find((r) => r.path === '/api/voice/turns')!.body).toEqual({
      entityId: ENTITY,
      conversationId: CONV,
      format: 'audio/pcm',
      sampleRate: 16000,
    });
    device.close();
  });

  it('a turn refused before its stream, or failed during it, throws with Nodal’s code', async () => {
    const refused = voiceNodal(() =>
      Response.json({ error: 'transcription_failed', detail: 'x' }, { status: 502 }),
    );
    const a = connect(BASE, session, { fetch: refused.nodal.fetch });
    await expect(a.say(PCM, 'audio/wav')).rejects.toMatchObject({
      code: 'request_failed',
      status: 502,
      serverCode: 'transcription_failed',
    });
    a.close();
    const failed = voiceNodal(() =>
      sseBody([
        ['transcript', { transcript: 'hi' }],
        ['error', { error: 'chat_failed' }],
      ]),
    );
    const b = connect(BASE, session, { fetch: failed.nodal.fetch });
    await expect(b.say(PCM, 'audio/wav')).rejects.toMatchObject({
      code: 'turn_failed',
      serverCode: 'chat_failed',
    });
    b.close();
  });
});

describe('the other gestures @cap:parler-par-canal-externe/moteur', () => {
  it('send, answer, cancel and the announcement’s voice reach the routes of the protocol, with their bodies', async () => {
    const live = liveStream();
    const nodal = fakeNodal({
      'GET /api/devices/:id/events': () => live.response,
      'POST /api/devices/:id/conversation': conversationRoute,
      'POST /api/chat/stream': () =>
        sseBody([
          ['delta', { text: 'Hel' }],
          [
            'done',
            {
              reply: 'Hello.',
              spawnedJobId: null,
              streamed: true,
              stopped: false,
              cutReason: null,
            },
          ],
        ]),
      'POST /api/approve': () =>
        Response.json({ jobId: 'j', status: 'queued', decision: 'approve', answer: 'Kitchen' }),
      'POST /api/chat/stop': () => Response.json({ stopped: true }),
      'GET /api/voice/replies/:a': () =>
        sseBody([
          ['audio', { seq: 0, sentence: 0, mimeType: 'audio/wav', base64: btoa('RIFF') }],
          ['audio_end', { sentence: 0, complete: true }],
          ['done', { text: 'Your report is ready.', speechError: null }],
        ]),
    });
    const device = connect(BASE, session, { fetch: nodal.fetch });
    const speech = collect(device, 'speech');
    const announces = collect(device, 'announce');

    expect(await device.send('Hi')).toMatchObject({
      transcript: 'Hi',
      reply: 'Hello.',
      stopped: false,
    });
    await device.answer(CARD, { label: 'Kitchen', decision: 'approve', answer: 'Kitchen' });
    expect(await device.cancel()).toBe(true);
    live.send(
      'announce',
      { type: 'announce', jobId: 'j7', conversationId: CONV, audioId: 'aud-1' },
      'e9',
    );
    await until(() => speech.some((s) => s.type === 'end'));

    const bodyOf = (path: string) => nodal.requests.find((r) => r.path.startsWith(path))!.body;
    expect(bodyOf('/api/chat/stream')).toEqual({
      entityId: ENTITY,
      agentId: AGENT,
      conversationId: CONV,
      message: 'Hi',
    });
    expect(bodyOf('/api/approve')).toEqual({
      approvalRequestId: CARD,
      decision: 'approve',
      answer: 'Kitchen',
    });
    expect(bodyOf('/api/chat/stop')).toEqual({ entityId: ENTITY, conversationId: CONV });
    expect(nodal.requests.find((r) => r.path.startsWith('/api/voice/replies/'))!.path).toBe(
      `/api/voice/replies/aud-1?entityId=${ENTITY}`,
    );
    expect(announces.map((a) => a.audioId)).toEqual(['aud-1']);
    const origin = { kind: 'announce', jobId: 'j7', audioId: 'aud-1' };
    expect(speech).toEqual([
      {
        type: 'audio',
        origin,
        seq: 0,
        sentence: 0,
        mimeType: 'audio/wav',
        audio: new TextEncoder().encode('RIFF'),
      },
      { type: 'sentence.end', origin, sentence: 0, complete: true },
      { type: 'end', origin, text: 'Your report is ready.', error: null },
    ]);
    // Every request is a route of the protocol table, with the device's token.
    const table = Object.values(DEVICE_GESTURES).flat();
    for (const r of nodal.requests) {
      const path = r.path.split('?')[0]!;
      const route = table.find(
        (t) =>
          t.method === r.method &&
          new RegExp(`^${t.path.replace(/:[A-Za-z]+/g, '[^/]+')}$`).test(path),
      );
      expect(route, `${r.method} ${path}`).toBeDefined();
      expect(r.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    }
    device.close();
  });

  it('cancel() during the upload deletes the open voice turn', async () => {
    const live = liveStream();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const nodal = fakeNodal({
      'GET /api/devices/:id/events': () => live.response,
      'POST /api/devices/:id/conversation': conversationRoute,
      'POST /api/voice/turns': () => Response.json({ turnId: 'turn-2' }, { status: 201 }),
      'POST /api/voice/turns/:t/chunks/:seq': async () => {
        await held;
        return Response.json({ received: 1 });
      },
      'DELETE /api/voice/turns/:t': () => Response.json({ cancelled: true }),
      'POST /api/chat/stop': () => Response.json({ stopped: false }),
    });
    const device = connect(BASE, session, { fetch: nodal.fetch, chunkBytes: 4 });
    const saying = device.say(new Uint8Array(12), 'audio/wav');
    await until(() => nodal.requests.some((r) => r.path.includes('/chunks/')));
    expect(await device.cancel()).toBe(true);
    release();
    expect(await saying).toMatchObject({ stopped: true, reply: null });
    expect(nodal.requests.map((r) => `${r.method} ${r.path}`)).toContain(
      'DELETE /api/voice/turns/turn-2',
    );
    expect(nodal.requests.some((r) => r.path.endsWith('/end'))).toBe(false);
    device.close();
  });
});

describe('every failure is a NodalDeviceError, the network’s included (review of #1013) @cap:parler-par-canal-externe/moteur', () => {
  const unreachable = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;

  it('a Nodal that cannot be reached: `network`, with the original error as its cause', async () => {
    const err = await pair(BASE, { name: 'x', capabilities: [], fetch: unreachable }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NodalDeviceError);
    expect(err).toMatchObject({ code: 'network' });
    expect((err as Error).cause).toBeInstanceOf(TypeError);

    const device = connect(BASE, session, { fetch: unreachable, backoff: { initialMs: 50 } });
    await expect(device.send('hi')).rejects.toMatchObject({ code: 'network' });
    device.close();
  });

  it('a poll that loses the network while the owner decides: `network`, not a raw TypeError', async () => {
    let polls = 0;
    const nodal = fakeNodal({
      'POST /api/devices/pair': () =>
        Response.json(
          {
            pairingId: 'p',
            deviceCode: 'dc',
            userCode: '123456',
            expiresInSeconds: 600,
            intervalSeconds: 0,
          },
          { status: 201 },
        ),
    });
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/poll') && ++polls === 1) throw new TypeError('fetch failed');
      return nodal.fetch(input, init);
    }) as typeof fetch;
    const pairing = await pair(BASE, { name: 'x', capabilities: [], fetch: flaky });
    await expect(pairing.done()).rejects.toMatchObject({ code: 'network' });
  });

  it('a turn whose stream is cut midway: `stream_cut`', async () => {
    const live = liveStream();
    const turnStream = liveStream();
    const nodal = fakeNodal({
      'GET /api/devices/:id/events': () => live.response,
      'POST /api/devices/:id/conversation': conversationRoute,
      'POST /api/chat/stream': () => turnStream.response,
    });
    const device = connect(BASE, session, { fetch: nodal.fetch });
    const sending = device.send('hi');
    await until(() => nodal.requests.some((r) => r.path === '/api/chat/stream'));
    turnStream.send('delta', { text: 'Hel' });
    turnStream.drop();
    await expect(sending).rejects.toMatchObject({ code: 'stream_cut' });
    device.close();
  });

  it('close() during a turn: the turn fails with `closed`', async () => {
    const live = liveStream();
    const turnStream = liveStream();
    const nodal = fakeNodal({
      'GET /api/devices/:id/events': () => live.response,
      'POST /api/devices/:id/conversation': conversationRoute,
      'POST /api/chat/stream': () => turnStream.response,
    });
    const device = connect(BASE, session, { fetch: nodal.fetch });
    const sending = device.send('hi');
    await until(() => nodal.requests.some((r) => r.path === '/api/chat/stream'));
    device.close();
    const err = await sending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodalDeviceError);
    expect(err).toMatchObject({ code: 'closed' });
  });
});

describe('after a resync, the waiting cards come back (#1012) @cap:approuver-une-action/moteur', () => {
  const waiting = {
    type: 'card',
    cardId: CARD,
    kind: 'approval',
    text: 'Approve?',
    choices: [
      { label: 'Approve', decision: 'approve' },
      { label: 'Reject', decision: 'reject' },
    ],
  };

  it('a card asked before the runner restarted reaches the device after `resync`, read from the cards route', async () => {
    const live = liveStream();
    const nodal = fakeNodal({
      'GET /api/devices/:id/events': () => live.response,
      'GET /api/devices/:id/cards': () => Response.json({ cards: [waiting] }),
    });
    const device = connect(BASE, session, { fetch: nodal.fetch });
    const cards = collect(device, 'card');
    const order: string[] = [];
    device.on('resync', () => order.push('resync'));
    device.on('card', () => order.push('card'));
    live.send('resync', { type: 'resync', reason: 'runner_restarted' }, 'h1');
    await until(() => cards.length === 1);
    expect(cards).toEqual([waiting]);
    expect(order).toEqual(['resync', 'card']);
    expect(nodal.requests.find((r) => r.path.endsWith('/cards'))).toMatchObject({
      method: 'GET',
      path: `/api/devices/${DEVICE}/cards`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    device.close();
  });

  it('a re-read the network interrupted is done again, before the next `ready`', async () => {
    const streams: LiveStream[] = [];
    let cardReads = 0;
    const nodal = fakeNodal({
      'GET /api/devices/:id/events': () => {
        const s = liveStream();
        streams.push(s);
        return s.response;
      },
      'GET /api/devices/:id/cards': () =>
        ++cardReads === 1
          ? Response.json({ error: 'busy' }, { status: 503 })
          : Response.json({ cards: [waiting] }),
    });
    const device = connect(BASE, session, {
      fetch: nodal.fetch,
      backoff: { initialMs: 5, maxMs: 5 },
    });
    const cards = collect(device, 'card');
    const ready = collect(device, 'ready');
    await until(() => streams.length === 1);
    streams[0]!.send('resync', { type: 'resync', reason: 'runner_restarted' }, 'h1');
    await until(() => streams.length === 2);
    // Reconnected from h1: no second resync, but the cards are still owed.
    streams[1]!.send('ready', {}, 'h1');
    await until(() => ready.length === 1);
    expect(cards).toEqual([waiting]);
    expect(cardReads).toBe(2);
    device.close();
  });
});

describe('a re-read after resync settles what the gap settled (review of #1013, pass 2) @cap:approuver-une-action/moteur', () => {
  const cardOf = (cardId: string) => ({
    type: 'card' as const,
    cardId,
    kind: 'approval' as const,
    text: `Approve ${cardId}?`,
    choices: [
      { label: 'Approve', decision: 'approve' as const },
      { label: 'Reject', decision: 'reject' as const },
    ],
  });
  const A = '0a0a0a0a-0000-4000-8000-00000000000a';
  const B = '0b0b0b0b-0000-4000-8000-00000000000b';

  /** A Nodal whose waiting cards the test sets, and whose cards route it can hold. */
  function nodalWithCards() {
    const live = liveStream();
    const state = { waiting: [] as unknown[], hold: null as Promise<void> | null };
    const nodal = fakeNodal({
      'GET /api/devices/:id/events': () => live.response,
      'GET /api/devices/:id/cards': async () => {
        const listed = [...state.waiting];
        if (state.hold) await state.hold;
        return Response.json({ cards: listed });
      },
      'POST /api/approve': () => Response.json({ jobId: 'j', status: 'queued' }),
    });
    return { live, state, nodal };
  }

  it('a card settled during the gap gets its card.closed after resync, marked as learned from the re-read', async () => {
    const { live, state, nodal } = nodalWithCards();
    const device = connect(BASE, session, { fetch: nodal.fetch });
    const closed = collect(device, 'card.closed');
    const cards = collect(device, 'card');
    live.send('card', cardOf(A), 'e1');
    await until(() => cards.length === 1);
    // The network drops, the owner rejects A on the dashboard: its card.closed
    // is lost with the stream. The runner restarted: resync, and A is no longer waiting.
    state.waiting = [];
    live.send('resync', { type: 'resync', reason: 'runner_restarted' }, 'h1');
    await until(() => closed.length === 1);
    expect(closed).toEqual([{ type: 'card.closed', cardId: A, text: null, source: 'reread' }]);
    device.close();
  });

  it('a card still waiting is not delivered twice; a new one is delivered once', async () => {
    const { live, state, nodal } = nodalWithCards();
    const device = connect(BASE, session, { fetch: nodal.fetch });
    const cards = collect(device, 'card');
    const closed = collect(device, 'card.closed');
    live.send('card', cardOf(A), 'e1');
    await until(() => cards.length === 1);
    state.waiting = [cardOf(A), cardOf(B)];
    live.send('resync', { type: 'resync', reason: 'runner_restarted' }, 'h1');
    await until(() => cards.length === 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(cards.map((c) => c.cardId)).toEqual([A, B]);
    expect(closed).toEqual([]);
    device.close();
  });

  it('two resync in a row: each re-read settles what it no longer lists, and delivers nothing twice', async () => {
    const { live, state, nodal } = nodalWithCards();
    const device = connect(BASE, session, { fetch: nodal.fetch });
    const cards = collect(device, 'card');
    const closed = collect(device, 'card.closed');
    state.waiting = [cardOf(A), cardOf(B)];
    live.send('resync', { type: 'resync', reason: 'runner_restarted' }, 'h1');
    await until(() => cards.length === 2);
    state.waiting = [cardOf(B)];
    live.send('resync', { type: 'resync', reason: 'cursor_too_old' }, 'h2');
    await until(() => closed.length === 1);
    state.waiting = [cardOf(B)];
    live.send('resync', { type: 'resync', reason: 'runner_restarted' }, 'h3');
    await until(() => nodal.requests.filter((r) => r.path.endsWith('/cards')).length === 3);
    await new Promise((r) => setTimeout(r, 30));
    expect(cards.map((c) => c.cardId)).toEqual([A, B]);
    expect(closed).toEqual([{ type: 'card.closed', cardId: A, text: null, source: 'reread' }]);
    device.close();
  });

  it('a settled card is never brought back: not by a replay, not by a re-read that still lists it', async () => {
    const { live, state, nodal } = nodalWithCards();
    const device = connect(BASE, session, { fetch: nodal.fetch });
    const cards = collect(device, 'card');
    const closed = collect(device, 'card.closed');
    live.send('card', cardOf(A), 'e1');
    live.send('card.closed', { type: 'card.closed', cardId: A, text: '❌ Rejected' }, 'e2');
    await until(() => closed.length === 1);
    // A replay around a reconnect sends the card again: it stays settled.
    live.send('card', cardOf(A), 'e1');
    // A re-read read just before the settlement reached the base still lists it.
    state.waiting = [cardOf(A)];
    live.send('resync', { type: 'resync', reason: 'runner_restarted' }, 'h1');
    await until(() => nodal.requests.some((r) => r.path.endsWith('/cards')));
    await new Promise((r) => setTimeout(r, 50));
    expect(cards.map((c) => c.cardId)).toEqual([A]);
    expect(closed.map((c) => c.source)).toEqual(['stream']);
    device.close();
  });

  it('a card.closed on the stream says its source and its text, once', async () => {
    const { live, nodal } = nodalWithCards();
    const device = connect(BASE, session, { fetch: nodal.fetch });
    const closed = collect(device, 'card.closed');
    live.send('card', cardOf(A), 'e1');
    live.send(
      'card.closed',
      { type: 'card.closed', cardId: A, text: '✅ Answered: Approve' },
      'e2',
    );
    await until(() => closed.length === 1);
    expect(closed).toEqual([
      { type: 'card.closed', cardId: A, text: '✅ Answered: Approve', source: 'stream' },
    ]);
    // Settled once: a later re-read that no longer lists it does not close it again.
    live.send('resync', { type: 'resync', reason: 'runner_restarted' }, 'h1');
    await until(() => nodal.requests.some((r) => r.path.endsWith('/cards')));
    await new Promise((r) => setTimeout(r, 30));
    expect(closed.map((c) => c.source)).toEqual(['stream']);
    device.close();
  });
});

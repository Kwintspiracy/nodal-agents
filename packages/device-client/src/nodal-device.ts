// nodal-device.ts — connect a device to Nodal (#950, #947).
//
// A device is anything that is not the dashboard and talks with a Nodal
// workspace: a speaker, a desktop companion, a small board, a piece of
// software. This file is the whole client. It has NO runtime dependency and
// builds to ONE file (`dist/nodal-device.mjs` + `.d.ts`) that a device project
// copies as is. It runs in Node 20+, in Electron (main and renderer) and in
// browsers: it only uses `fetch`, `TextDecoder`, `AbortController` and timers.
//
//   const pairing = await pair(url, { name, capabilities });   // show or say pairing.userCode
//   const session = await pairing.done();                      // the owner confirmed it
//   const nodal = connect(url, session);                       // keep `session` to reconnect
//   nodal.on('card', (card) => …); await nodal.say(wav, 'audio/wav');
//
// The protocol itself (events, payloads, routes) is NOT written here: it comes
// from the single protocol module `packages/shared/src/device-protocol.ts`,
// through `protocol.generated.ts`, which a test regenerates and compares.
//
// THE EVENT STREAM. `GET /api/devices/:deviceId/events` (SSE, read through a
// `fetch` stream so that the `Authorization` header works everywhere, which
// `EventSource` does not allow). Every event carries a resume id; after a
// network drop the client reconnects by itself, with backoff, sending
// `Last-Event-ID`, and the runner replays what was missed — a card included.
// When the runner cannot replay (it restarted, or the gap is too old) it says
// `resync`: the client passes it on, and re-reads the cards still waiting
// (`GET /api/devices/:deviceId/cards`), handing each to `card` again. A
// re-read a drop interrupts is done again before the next `ready`.
//
// A refused token (the owner removed the device, or revoked it) ends the
// session with a `NodalDeviceError` of code `revoked`: never an endless retry.

import {
  DEVICE_GESTURES,
  DEVICE_PAIRING_GESTURES,
  DEVICE_POLL_STATUS,
  DEVICE_PROTOCOL_VERSION,
  type DeviceCapability,
  type DeviceCardChoice,
  type DeviceEvent,
} from './protocol.generated.ts';

export {
  DEVICE_CAPABILITIES,
  DEVICE_GESTURES,
  DEVICE_PAIRING_GESTURES,
  DEVICE_PROTOCOL_VERSION,
  type DeviceCapability,
  type DeviceCardChoice,
  type DeviceDeliverable,
  type DeviceEvent,
  type DeviceEventType,
  type DeviceRunState,
} from './protocol.generated.ts';

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Why a call failed, as a code a device can switch on. EVERY failure of this
 * client is a `NodalDeviceError`, the network's included: the transport is
 * wrapped in one place (`transport`, below), and the original error is kept
 * as `cause`.
 *   - `refused`: the owner refused the pairing;
 *   - `expired`: the pairing code expired before the owner confirmed it;
 *   - `revoked`: Nodal refused the device's token (removed or revoked): pair again;
 *   - `request_failed`: Nodal answered an error (`status`, and its own `serverCode`);
 *   - `turn_failed`: a spoken or typed turn failed after it started (`serverCode`);
 *   - `protocol`: Nodal answered something this client cannot read;
 *   - `network`: Nodal could not be reached (no route, refused, DNS, a drop
 *     before the answer);
 *   - `stream_cut`: an answer or a stream stopped before its end;
 *   - `aborted`: the call was aborted by the device's own `signal`;
 *   - `closed`: the session was closed (by `close()`, while a call was running).
 */
export type NodalDeviceErrorCode =
  | 'refused'
  | 'expired'
  | 'revoked'
  | 'request_failed'
  | 'turn_failed'
  | 'protocol'
  | 'network'
  | 'stream_cut'
  | 'aborted'
  | 'closed';

export class NodalDeviceError extends Error {
  readonly code: NodalDeviceErrorCode;
  /** The HTTP status Nodal answered, when there was one. */
  readonly status: number | undefined;
  /** Nodal's own error code (`turn_not_found`, `voice_key_missing`…), when it gave one. */
  readonly serverCode: string | undefined;

  constructor(
    code: NodalDeviceErrorCode,
    message: string,
    extra: { status?: number; serverCode?: string; cause?: unknown } = {},
  ) {
    super(message, extra.cause !== undefined ? { cause: extra.cause } : undefined);
    this.name = 'NodalDeviceError';
    this.code = code;
    this.status = extra.status;
    this.serverCode = extra.serverCode;
  }
}

// ─── Options shared by pair() and connect() ──────────────────────────────────

export interface FetchOptions {
  /** The `fetch` to use. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

function isAbort(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * THE one place a transport failure becomes a `NodalDeviceError`: a request
 * that never got an answer (`network`), or a body that stopped mid-way
 * (`stream_cut`); either one aborted by a signal is `aborted`.
 */
function transportError(err: unknown, phase: 'request' | 'body'): NodalDeviceError {
  if (err instanceof NodalDeviceError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  if (isAbort(err)) return new NodalDeviceError('aborted', `aborted: ${detail}`, { cause: err });
  return phase === 'request'
    ? new NodalDeviceError('network', `network: Nodal could not be reached (${detail})`, {
        cause: err,
      })
    : new NodalDeviceError('stream_cut', `stream_cut: Nodal's answer stopped midway (${detail})`, {
        cause: err,
      });
}

/** The `fetch` every call of this client goes through: its failures are `NodalDeviceError`s. */
function fetchOf(options: FetchOptions): typeof fetch {
  const f = options.fetch ?? globalThis.fetch;
  if (typeof f !== 'function') {
    throw new NodalDeviceError('network', 'network: no fetch available; pass options.fetch');
  }
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      return await f(input, init);
    } catch (err) {
      throw transportError(err, 'request');
    }
  }) as typeof fetch;
}

/** `http://host:3001/` + `/api/x` → `http://host:3001/api/x`. */
function urlOf(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path;
}

/** A route of the protocol table with its `:params` filled in. */
function fill(path: string, params: Record<string, string>): string {
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new TypeError(`nodal-device: missing route param ${name}`);
    return encodeURIComponent(value);
  });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw transportError(err, 'body');
  }
  if (text.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    throw new NodalDeviceError(
      'protocol',
      `Nodal answered ${res.status} with a body that is not JSON`,
      {
        status: res.status,
      },
    );
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

// ─── Pairing ─────────────────────────────────────────────────────────────────

/** What a paired device keeps to reconnect later without pairing again. */
export interface DeviceSession {
  deviceId: string;
  /** `ndv_…`: a secret. Store it like a password. */
  token: string;
  conversationId: string;
}

export interface PairOptions extends FetchOptions {
  /** The name the owner sees in Settings → Devices (1 to 60 characters). */
  name: string;
  /** What the device can do. A device without a screen says its code and reads cards aloud. */
  capabilities: DeviceCapability[];
  /** Stops waiting in `done()`. */
  signal?: AbortSignal;
}

export interface Pairing {
  /** The 6 digits to show or say. The owner types them in Settings → Devices. */
  userCode: string;
  pairingId: string;
  /** How long the code is valid, from the moment `pair()` returned. */
  expiresInSeconds: number;
  /**
   * Waits for the owner. Resolves with the session once they confirm; throws a
   * `NodalDeviceError` with code `refused` or `expired` otherwise.
   */
  done(): Promise<DeviceSession>;
}

/** Ask Nodal to pair this device. Nothing is granted until the owner confirms. */
export async function pair(baseUrl: string, options: PairOptions): Promise<Pairing> {
  const f = fetchOf(options);
  const res = await f(urlOf(baseUrl, DEVICE_PAIRING_GESTURES.pair[0].path), {
    method: DEVICE_PAIRING_GESTURES.pair[0].method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: options.name,
      capabilities: options.capabilities,
      protocolVersion: DEVICE_PROTOCOL_VERSION,
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const body = await readJson(res);
  if (res.status !== 201) {
    throw new NodalDeviceError(
      'request_failed',
      `Nodal refused the pairing request (${res.status}${str(body['error']) ? ` ${str(body['error'])}` : ''})`,
      { status: res.status, ...(str(body['error']) ? { serverCode: str(body['error']) } : {}) },
    );
  }
  const deviceCode = str(body['deviceCode']);
  const userCode = str(body['userCode']);
  const pairingId = str(body['pairingId']);
  const expiresInSeconds = body['expiresInSeconds'];
  const intervalSeconds = body['intervalSeconds'];
  if (
    !deviceCode ||
    !userCode ||
    !pairingId ||
    typeof expiresInSeconds !== 'number' ||
    typeof intervalSeconds !== 'number'
  ) {
    throw new NodalDeviceError('protocol', 'Nodal answered a pairing without its codes', {
      status: res.status,
    });
  }

  let waiting: Promise<DeviceSession> | null = null;
  const poll = async (): Promise<DeviceSession> => {
    let interval = intervalSeconds;
    for (;;) {
      await sleep(interval * 1000, options.signal);
      if (options.signal?.aborted) {
        throw new NodalDeviceError('closed', 'pairing abandoned by the device');
      }
      const r = await f(urlOf(baseUrl, DEVICE_PAIRING_GESTURES.pair[1].path), {
        method: DEVICE_PAIRING_GESTURES.pair[1].method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const b = await readJson(r);
      const status = str(b['status']);
      if (r.status === DEVICE_POLL_STATUS.pending && status === 'pending') continue;
      if (r.status === DEVICE_POLL_STATUS.slow_down && status === 'slow_down') {
        // Polled too fast (a clock that jumped, a shared IP): wait longer, as
        // the OAuth device flow does.
        interval += 5;
        continue;
      }
      if (r.status === DEVICE_POLL_STATUS.paired && status === 'paired') {
        const deviceId = str(b['deviceId']);
        const token = str(b['token']);
        const conversationId = str(b['conversationId']);
        if (!deviceId || !token || !conversationId) {
          throw new NodalDeviceError('protocol', 'Nodal answered a pairing without its session', {
            status: r.status,
          });
        }
        return { deviceId, token, conversationId };
      }
      if (r.status === DEVICE_POLL_STATUS.refused && status === 'refused') {
        throw new NodalDeviceError('refused', 'refused: the owner refused this device', {
          status: r.status,
          serverCode: 'refused',
        });
      }
      if (r.status === DEVICE_POLL_STATUS.expired && status === 'expired') {
        throw new NodalDeviceError('expired', 'expired: the pairing code expired, pair again', {
          status: r.status,
          serverCode: 'expired',
        });
      }
      throw new NodalDeviceError(
        'request_failed',
        `Nodal answered the pairing poll with ${r.status}${status ? ` ${status}` : ''}`,
        { status: r.status, ...(str(b['error']) ? { serverCode: str(b['error']) } : {}) },
      );
    }
  };

  return {
    userCode,
    pairingId,
    expiresInSeconds,
    done: () => (waiting ??= poll()),
  };
}

// ─── Server-Sent Events, read from a fetch stream ────────────────────────────

/** One SSE event as it arrives: its name, its data, and the stream's current resume id. */
export interface SseMessage {
  event: string;
  data: string;
  /** The last `id:` the stream gave, this event's or an earlier one's. */
  lastEventId: string | null;
}

/**
 * Reads an SSE body (the WHATWG format: `\n`, `\r\n` or `\r` line ends,
 * `:` comments, multi-line `data:`). Yields one message per blank line.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  lastEventId: string | null = null,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let id = lastEventId;
  let sawCr = false;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw transportError(err, 'body');
      }
      const { value, done } = chunk;
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // A `\r\n` split across two reads: the `\n` that follows a `\r` already
      // seen ends nothing.
      if (sawCr && buffer.startsWith('\n')) buffer = buffer.slice(1);
      sawCr = false;
      for (;;) {
        const m = /\r\n|\r|\n/.exec(buffer);
        if (!m) break;
        // A lone `\r` at the very end may be the first half of `\r\n`.
        if (m[0] === '\r' && m.index === buffer.length - 1 && !done) {
          sawCr = true;
        }
        const line = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        if (line === '') {
          if (data.length > 0) {
            yield { event: event || 'message', data: data.join('\n'), lastEventId: id };
          }
          event = '';
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value2 = colon === -1 ? '' : line.slice(colon + 1);
        if (value2.startsWith(' ')) value2 = value2.slice(1);
        if (field === 'event') event = value2;
        else if (field === 'data') data.push(value2);
        else if (field === 'id' && !value2.includes('\0')) id = value2;
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Speech ──────────────────────────────────────────────────────────────────

/** Whose voice a `speech` event is: the reply to a turn this device spoke, or a job's announcement. */
export type SpeechOrigin =
  | { kind: 'turn'; turnId: string }
  | { kind: 'announce'; jobId: string; audioId: string };

/**
 * The agent's voice, in order:
 *   - `audio`: a piece of a sentence. Play them end to end in `seq` order.
 *     `audio/pcm` is 16-bit signed little-endian mono at `sampleRate`; any
 *     other type (`audio/wav`, `audio/mpeg`…) only decodes per whole sentence;
 *   - `sentence.end`: sentence `sentence` is over. `complete` false: it stopped
 *     midway (the voice failed, Stop) — drop a compressed sentence then;
 *   - `end`: nothing more comes for this origin. `text` is what was said;
 *     `error` says why the voice failed while the text stands.
 */
export type SpeechEvent =
  | {
      type: 'audio';
      origin: SpeechOrigin;
      seq: number;
      sentence: number;
      mimeType: string;
      sampleRate?: number;
      audio: Uint8Array;
    }
  | { type: 'sentence.end'; origin: SpeechOrigin; sentence: number; complete: boolean }
  | {
      type: 'end';
      origin: SpeechOrigin;
      text: string | null;
      error: { code: string; detail?: string } | null;
    };

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function parseData(msg: SseMessage): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(msg.data);
    if (v !== null && typeof v === 'object') return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new NodalDeviceError(
    'protocol',
    `Nodal sent a "${msg.event}" event that is not a JSON object`,
  );
}

/** The `audio` / `audio_end` events of a voice stream, as `SpeechEvent`s; anything else: null. */
function speechOf(msg: SseMessage, origin: SpeechOrigin): SpeechEvent | null {
  if (msg.event === 'audio') {
    const d = parseData(msg);
    const { seq, sentence, mimeType, sampleRate, base64 } = d;
    if (
      typeof seq !== 'number' ||
      typeof sentence !== 'number' ||
      typeof mimeType !== 'string' ||
      typeof base64 !== 'string'
    ) {
      throw new NodalDeviceError('protocol', 'Nodal sent an audio event without its fields');
    }
    return {
      type: 'audio',
      origin,
      seq,
      sentence,
      mimeType,
      ...(typeof sampleRate === 'number' ? { sampleRate } : {}),
      audio: base64ToBytes(base64),
    };
  }
  if (msg.event === 'audio_end') {
    const d = parseData(msg);
    if (typeof d['sentence'] !== 'number' || typeof d['complete'] !== 'boolean') {
      throw new NodalDeviceError('protocol', 'Nodal sent an audio_end event without its fields');
    }
    return { type: 'sentence.end', origin, sentence: d['sentence'], complete: d['complete'] };
  }
  return null;
}

function speechErrorOf(v: unknown): { code: string; detail?: string } | null {
  if (v === null || typeof v !== 'object') return null;
  const code = str((v as Record<string, unknown>)['code']);
  if (!code) return null;
  const detail = str((v as Record<string, unknown>)['detail']);
  return { code, ...(detail ? { detail } : {}) };
}

// ─── The connection ──────────────────────────────────────────────────────────

type EventOf<T extends DeviceEvent['type']> = Extract<DeviceEvent, { type: T }>;

/** Everything `on()` can listen to. */
export interface NodalDeviceEvents {
  /** Something to read or hear: an agent's reply to a job launched here, a message sent here. */
  bubble: EventOf<'bubble'>;
  /**
   * Nodal asks the person: approve an action, or choose an option. Answer with
   * `answer()`. Each card is delivered ONCE while it is open, even when a
   * reconnect replays it or a re-read lists it again.
   */
  card: EventOf<'card'>;
  /**
   * A card was settled (here, elsewhere, or by expiry). Stop showing or saying it.
   * `source: 'stream'`: Nodal said so, and `text` is what the card says now.
   * `source: 'reread'`: the card was missing from the waiting cards read after
   * a `resync`, so it was settled while the device was away; how is not known,
   * and `text` is null.
   */
  'card.closed':
    | (EventOf<'card.closed'> & { source: 'stream' })
    | { type: 'card.closed'; cardId: string; text: null; source: 'reread' };
  /** Where a job launched from this device stands. */
  state: EventOf<'state'>;
  /** A job launched by voice ended, and its announcement is spoken: its voice follows as `speech`. */
  announce: EventOf<'announce'>;
  /** The agent's voice: the reply to a spoken turn, or an announcement. */
  speech: SpeechEvent;
  /** The stream is live (after any replay). */
  ready: { reconnected: boolean };
  /**
   * The runner could not replay what was missed (it restarted, or the gap is
   * too old). The client then re-reads the cards still waiting and hands each
   * to `card` again; a bubble or a state missed is not given back.
   */
  resync: { reason: string };
  /** The stream dropped; the client retries in `retryInMs`. */
  disconnected: { error: string; retryInMs: number };
  /** The session ended for good: `revoked`, or `closed` by `close()`. */
  closed: { error: NodalDeviceError };
}

export interface ConnectOptions extends FetchOptions {
  /** Fetch each announcement's voice and emit it as `speech`. Default true. */
  hearAnnouncements?: boolean;
  /** Reconnection backoff: first delay and ceiling, in ms. Default 500 and 30 000. */
  backoff?: { initialMs?: number; maxMs?: number };
  /**
   * The stream is considered dead when nothing (not even its 25 s ping) arrived
   * for this long, and is reopened. Default 60 000 ms.
   */
  idleTimeoutMs?: number;
  /** Bytes per upload request in `say()`. Default 256 KiB. */
  chunkBytes?: number;
}

export interface SayOptions {
  /** Required for `audio/pcm` (16-bit signed little-endian mono); refused for `audio/wav`. */
  sampleRate?: number;
}

export interface TurnResult {
  /** What Nodal heard (spoken turn), or what was sent (typed turn). Null: nothing was heard. */
  transcript: string | null;
  /** The agent's whole reply. Null when nothing was heard. */
  reply: string | null;
  /** A job the agent launched for this turn: its end arrives as `bubble` / `state` / `announce`. */
  spawnedJobId: string | null;
  /** The turn was stopped by `cancel()`. */
  stopped: boolean;
  /** The voice failed while the text stands (spoken turn only). */
  speechError: { code: string; detail?: string } | null;
}

export interface NodalDevice {
  readonly deviceId: string;
  on<K extends keyof NodalDeviceEvents>(
    type: K,
    handler: (event: NodalDeviceEvents[K]) => void,
  ): () => void;
  /** One spoken turn: the audio of a push-to-talk. The reply's voice comes as `speech` events. */
  say(
    audio: Uint8Array | ArrayBuffer,
    mimeType: 'audio/wav' | 'audio/pcm',
    options?: SayOptions,
  ): Promise<TurnResult>;
  /** One typed turn. */
  send(text: string): Promise<TurnResult>;
  /** Answer a card with one of its `choices`. */
  answer(cardId: string, choice: DeviceCardChoice): Promise<void>;
  /** Stop the current turn. Resolves true when a turn was running. */
  cancel(): Promise<boolean>;
  /** Start a new conversation (like `/new`): the next turns begin from a blank thread. */
  newConversation(): Promise<string>;
  close(): void;
}

interface Conversation {
  entityId: string;
  agentId: string;
  conversationId: string;
}

/** Open the device's connection with a session from `pair().done()`, now or later. */
export function connect(
  baseUrl: string,
  session: DeviceSession,
  options: ConnectOptions = {},
): NodalDevice {
  const f = fetchOf(options);
  const hearAnnouncements = options.hearAnnouncements ?? true;
  const initialMs = options.backoff?.initialMs ?? 500;
  const maxMs = options.backoff?.maxMs ?? 30_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  const chunkBytes = options.chunkBytes ?? 256 * 1024;

  const handlers = new Map<string, Set<(e: never) => void>>();
  const life = new AbortController();
  let ended: NodalDeviceError | null = null;
  let conversation: Promise<Conversation> | null = null;
  /** The spoken turn whose audio is being uploaded, for `cancel()`. */
  let openTurnId: string | null = null;

  const emit = <K extends keyof NodalDeviceEvents>(type: K, event: NodalDeviceEvents[K]): void => {
    for (const h of handlers.get(type) ?? []) {
      try {
        (h as (e: NodalDeviceEvents[K]) => void)(event);
      } catch (err) {
        // A handler's bug is the device's, not the stream's: say it, go on.
        console.error(`[nodal-device] a "${type}" handler threw:`, err);
      }
    }
  };

  const end = (error: NodalDeviceError): void => {
    if (ended) return;
    ended = error;
    life.abort();
    emit('closed', { error });
  };

  const ensureOpen = (): void => {
    if (ended) throw ended;
  };

  const authHeaders = (): Record<string, string> => ({ authorization: `Bearer ${session.token}` });

  /** A request to Nodal with the device's token. A refused token ends the session. */
  const request = async (
    method: string,
    path: string,
    body?: unknown,
    raw?: Uint8Array,
  ): Promise<Response> => {
    ensureOpen();
    const headers: Record<string, string> = authHeaders();
    let payload: BodyInit | undefined;
    if (raw) {
      headers['content-type'] = 'application/octet-stream';
      payload = raw as unknown as BodyInit;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await f(urlOf(baseUrl, path), {
      method,
      headers,
      ...(payload !== undefined ? { body: payload } : {}),
      signal: life.signal,
    });
    if (res.ok) return res;
    const b = await readJson(res).catch(() => ({}) as Record<string, unknown>);
    const serverCode = str(b['error']);
    if (res.status === 401) {
      const err = new NodalDeviceError(
        'revoked',
        `revoked: Nodal refused this device's token${serverCode ? ` (${serverCode})` : ''}. The device was removed or its token revoked: pair again.`,
        { status: 401, ...(serverCode ? { serverCode } : {}) },
      );
      end(err);
      throw err;
    }
    throw new NodalDeviceError(
      'request_failed',
      `Nodal answered ${res.status}${serverCode ? ` ${serverCode}` : ''} to ${method} ${path}`,
      { status: res.status, ...(serverCode ? { serverCode } : {}) },
    );
  };

  const readConversation = async (fresh: boolean): Promise<Conversation> => {
    const res = await request(
      'POST',
      fill(DEVICE_GESTURES.conversation[0].path, { deviceId: session.deviceId }),
      fresh ? { fresh: true } : {},
    );
    const b = await readJson(res);
    const entityId = str(b['entityId']);
    const agentId = str(b['agentId']);
    const conversationId = str(b['conversationId']);
    if (!entityId || !agentId || !conversationId) {
      throw new NodalDeviceError('protocol', 'Nodal answered a conversation without its ids');
    }
    return { entityId, agentId, conversationId };
  };

  const currentConversation = (): Promise<Conversation> => {
    if (!conversation) {
      conversation = readConversation(false);
      // A failed read is retried by the next gesture, not cached.
      conversation.catch(() => {
        conversation = null;
      });
    }
    return conversation;
  };

  // ── The cards the device holds open ──
  // Every card delivered and not yet settled. A card is delivered once while it
  // is open; a settled card (closed on the stream, or missing from a re-read)
  // is never delivered again, by a replay or a re-read: a request never reopens.
  const openCards = new Set<string>();
  const settledCards = new Set<string>();
  const SETTLED_KEPT = 1000;
  const settleCard = (cardId: string): void => {
    openCards.delete(cardId);
    settledCards.add(cardId);
    if (settledCards.size > SETTLED_KEPT) {
      settledCards.delete(settledCards.values().next().value as string);
    }
  };
  const deliverCard = (card: EventOf<'card'>): void => {
    if (openCards.has(card.cardId) || settledCards.has(card.cardId)) return;
    openCards.add(card.cardId);
    emit('card', card);
  };

  // ── The event stream ──
  const onDeviceEvent = (type: string, data: Record<string, unknown>): void => {
    switch (type) {
      case 'card':
        deliverCard(data as EventOf<'card'>);
        return;
      case 'card.closed': {
        const ev = data as EventOf<'card.closed'>;
        settleCard(ev.cardId);
        emit('card.closed', { ...ev, source: 'stream' });
        return;
      }
      case 'bubble':
      case 'state':
        emit(type, data as never);
        return;
      case 'announce': {
        const ev = data as EventOf<'announce'>;
        emit('announce', ev);
        if (hearAnnouncements) void hearAnnouncement(ev);
        return;
      }
      default:
        // An event a newer Nodal sends and this client does not know yet: the
        // protocol only ever adds events (DEVICE_PROTOCOL_VERSION).
        return;
    }
  };

  const hearAnnouncement = async (ev: EventOf<'announce'>): Promise<void> => {
    const origin: SpeechOrigin = { kind: 'announce', jobId: ev.jobId, audioId: ev.audioId };
    try {
      const conv = await currentConversation();
      const res = await request(
        'GET',
        `${fill(DEVICE_GESTURES.hear[0].path, { audioId: ev.audioId })}?entityId=${encodeURIComponent(conv.entityId)}`,
      );
      if (!res.body)
        throw new NodalDeviceError('protocol', 'Nodal answered an announcement without a body');
      for await (const msg of readSse(res.body)) {
        const s = speechOf(msg, origin);
        if (s) emit('speech', s);
        else if (msg.event === 'done') {
          const d = parseData(msg);
          emit('speech', {
            type: 'end',
            origin,
            text: typeof d['text'] === 'string' ? d['text'] : null,
            error: speechErrorOf(d['speechError']),
          });
          return;
        }
      }
      emit('speech', {
        type: 'end',
        origin,
        text: null,
        error: { code: 'stream_cut', detail: 'the announcement stream ended before done' },
      });
    } catch (err) {
      if (ended) return;
      emit('speech', {
        type: 'end',
        origin,
        text: null,
        error: {
          code: err instanceof NodalDeviceError ? (err.serverCode ?? err.code) : 'stream_cut',
          detail: String(err),
        },
      });
    }
  };

  let cardsToReread = false;
  const rereadCards = async (): Promise<void> => {
    const res = await request(
      'GET',
      fill(DEVICE_GESTURES.cards[0].path, { deviceId: session.deviceId }),
    );
    const cards = (await readJson(res))['cards'];
    if (!Array.isArray(cards)) {
      throw new NodalDeviceError('protocol', 'Nodal answered the waiting cards without their list');
    }
    cardsToReread = false;
    const waiting = cards as EventOf<'card'>[];
    const listed = new Set(waiting.map((c) => c.cardId));
    // An open card the base no longer lists was settled during the gap: its
    // `card.closed` was lost with the stream. Said now, never kept on screen.
    for (const cardId of [...openCards]) {
      if (listed.has(cardId)) continue;
      settleCard(cardId);
      emit('card.closed', { type: 'card.closed', cardId, text: null, source: 'reread' });
    }
    for (const card of waiting) deliverCard(card);
  };

  const listen = async (): Promise<void> => {
    let lastEventId: string | null = null;
    let delay = initialMs;
    let connections = 0;
    while (!ended) {
      const attempt = new AbortController();
      const abortAttempt = (): void => attempt.abort();
      life.signal.addEventListener('abort', abortAttempt, { once: true });
      let idle: ReturnType<typeof setTimeout> | undefined;
      const arm = (): void => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => attempt.abort(), idleTimeoutMs);
      };
      let failure = 'stream ended';
      try {
        arm();
        const res: Response = await f(
          urlOf(baseUrl, fill(DEVICE_GESTURES.listen[0].path, { deviceId: session.deviceId })),
          {
            method: 'GET',
            headers: {
              ...authHeaders(),
              accept: 'text/event-stream',
              ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
            },
            signal: attempt.signal,
          },
        );
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          const b = await readJson(res).catch(() => ({}) as Record<string, unknown>);
          const serverCode = str(b['error']);
          end(
            new NodalDeviceError(
              'revoked',
              `revoked: Nodal refused this device's stream (${res.status}${serverCode ? ` ${serverCode}` : ''}). The device was removed or its token revoked: pair again.`,
              { status: res.status, ...(serverCode ? { serverCode } : {}) },
            ),
          );
          return;
        }
        if (!res.ok || !res.body) {
          failure = `Nodal answered ${res.status}`;
        } else {
          const messages: AsyncGenerator<SseMessage> = readSse(
            dataStream(res.body, arm),
            lastEventId,
          );
          for await (const msg of messages) {
            lastEventId = msg.lastEventId;
            if (msg.event === 'ready') {
              delay = initialMs;
              // A re-read a drop interrupted is done now, before going live.
              if (cardsToReread) await rereadCards();
              emit('ready', { reconnected: connections > 0 });
              connections++;
            } else if (msg.event === 'resync') {
              delay = initialMs;
              const d = parseData(msg);
              emit('resync', { reason: str(d['reason']) ?? 'unknown' });
              connections++;
              // What the stream lost, the base gives back: every card still
              // waiting, handed to `card` again. Until it is read, the flag
              // stays up, and a reconnect reads it before `ready`.
              cardsToReread = true;
              await rereadCards();
            } else {
              onDeviceEvent(msg.event, parseData(msg));
            }
          }
        }
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      } finally {
        if (idle) clearTimeout(idle);
        life.signal.removeEventListener('abort', abortAttempt);
      }
      if (ended) return;
      // Full jitter: many devices that lost the same Wi-Fi do not come back in step.
      const wait = Math.round(delay / 2 + Math.random() * (delay / 2));
      emit('disconnected', { error: failure, retryInMs: wait });
      await sleep(wait, life.signal);
      delay = Math.min(delay * 2, maxMs);
    }
  };

  void listen();

  // ── Gestures ──
  const readTurn = async (
    res: Response,
    origin: SpeechOrigin | null,
    sent: string | null,
  ): Promise<TurnResult> => {
    if (!res.body) throw new NodalDeviceError('protocol', 'Nodal answered a turn without a body');
    let transcript = sent;
    for await (const msg of readSse(res.body)) {
      if (origin) {
        const s = speechOf(msg, origin);
        if (s) {
          emit('speech', s);
          continue;
        }
      }
      switch (msg.event) {
        case 'nothing_heard':
          return {
            transcript: null,
            reply: null,
            spawnedJobId: null,
            stopped: false,
            speechError: null,
          };
        case 'transcript':
          transcript = str(parseData(msg)['transcript']) ?? null;
          break;
        case 'done': {
          const d = parseData(msg);
          const reply = typeof d['reply'] === 'string' ? d['reply'] : '';
          const speechError = speechErrorOf(d['speechError']);
          if (origin) emit('speech', { type: 'end', origin, text: reply, error: speechError });
          return {
            transcript,
            reply,
            spawnedJobId: str(d['spawnedJobId']) ?? null,
            stopped: d['stopped'] === true,
            speechError,
          };
        }
        case 'error': {
          const d = parseData(msg);
          const code = str(d['error']) ?? 'unknown';
          throw new NodalDeviceError('turn_failed', `the turn failed: ${code}`, {
            serverCode: code,
          });
        }
        default:
          // `delta`: the reply as it is written. `done.reply` is the whole reply.
          break;
      }
    }
    throw new NodalDeviceError('stream_cut', 'stream_cut: the turn stream ended before done');
  };

  const say: NodalDevice['say'] = async (audio, mimeType, sayOptions = {}) => {
    const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
    const conv = await currentConversation();
    const [start, chunk, finish] = DEVICE_GESTURES.say;
    const startRes = await request('POST', start.path, {
      entityId: conv.entityId,
      conversationId: conv.conversationId,
      format: mimeType,
      ...(sayOptions.sampleRate !== undefined ? { sampleRate: sayOptions.sampleRate } : {}),
    });
    const turnId = str((await readJson(startRes))['turnId']);
    if (!turnId) throw new NodalDeviceError('protocol', 'Nodal opened a voice turn without its id');
    openTurnId = turnId;
    // `cancel()` during the upload deletes the turn: nothing was said.
    const cancelled = (): boolean => openTurnId !== turnId;
    const stoppedTurn: TurnResult = {
      transcript: null,
      reply: null,
      spawnedJobId: null,
      stopped: true,
      speechError: null,
    };
    try {
      for (let seq = 0, at = 0; at < bytes.length; seq++, at += chunkBytes) {
        try {
          await request(
            'POST',
            fill(chunk.path, { turnId, seq: String(seq) }),
            undefined,
            bytes.subarray(at, at + chunkBytes),
          );
        } catch (err) {
          if (cancelled()) return stoppedTurn;
          throw err;
        }
        if (cancelled()) return stoppedTurn;
      }
      const endRes = await request('POST', fill(finish.path, { turnId }));
      openTurnId = null;
      return await readTurn(endRes, { kind: 'turn', turnId }, null);
    } finally {
      if (openTurnId === turnId) openTurnId = null;
    }
  };

  const send: NodalDevice['send'] = async (text) => {
    const conv = await currentConversation();
    const res = await request('POST', DEVICE_GESTURES.send[0].path, {
      entityId: conv.entityId,
      agentId: conv.agentId,
      conversationId: conv.conversationId,
      message: text,
    });
    return readTurn(res, null, text);
  };

  const answer: NodalDevice['answer'] = async (cardId, choice) => {
    await request('POST', DEVICE_GESTURES.answer[0].path, {
      approvalRequestId: cardId,
      decision: choice.decision,
      ...(choice.answer !== undefined ? { answer: choice.answer } : {}),
    });
  };

  const cancel: NodalDevice['cancel'] = async () => {
    const [cancelTurn, stopChat] = DEVICE_GESTURES.cancel;
    let stopped = false;
    const pending = openTurnId;
    if (pending) {
      openTurnId = null;
      const res = await request('DELETE', fill(cancelTurn.path, { turnId: pending })).catch(
        (err: unknown) => {
          // The turn already ended (its end request raced the cancel): the chat
          // Stop below is what stops it now.
          if (err instanceof NodalDeviceError && err.serverCode === 'turn_not_found') return null;
          throw err;
        },
      );
      if (res) stopped = (await readJson(res))['cancelled'] === true;
    }
    const conv = await currentConversation();
    const res = await request('POST', stopChat.path, {
      entityId: conv.entityId,
      conversationId: conv.conversationId,
    });
    return (await readJson(res))['stopped'] === true || stopped;
  };

  /**
   * A gesture whose session ended while it ran (`close()`, a revoked key)
   * fails with the session's end, not with the abort that end caused.
   */
  const gesture =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await fn(...args);
      } catch (err) {
        if (ended) throw ended;
        if (err instanceof NodalDeviceError) throw err;
        const detail = err instanceof Error ? err.message : String(err);
        throw new NodalDeviceError('protocol', `protocol: ${detail}`, { cause: err });
      }
    };

  return {
    deviceId: session.deviceId,
    on(type, handler) {
      let set = handlers.get(type);
      if (!set) handlers.set(type, (set = new Set()));
      set.add(handler as (e: never) => void);
      return () => set.delete(handler as (e: never) => void);
    },
    say: gesture(say),
    send: gesture(send),
    answer: gesture(answer),
    cancel: gesture(cancel),
    newConversation: gesture(async () => {
      const next = readConversation(true);
      conversation = next;
      return (await next).conversationId;
    }),
    close() {
      end(new NodalDeviceError('closed', 'closed by the device'));
    },
  };
}

/** The body, re-armed on every byte that arrives (the ping included). */
function dataStream(
  body: ReadableStream<Uint8Array>,
  onData: () => void,
): ReadableStream<Uint8Array> {
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        onData();
        controller.enqueue(chunk);
      },
    }),
  );
}

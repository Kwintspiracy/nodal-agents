// speech-server.ts — a REAL speech/transcription server for tests (#1048).
//
// Nodal reaches a server the user runs by the standard OpenAI audio surface.
// A test of that path that mocks `fetch` proves only that a function was
// called: this one starts an HTTP server on a free port of 127.0.0.1 that
// answers the three routes as such servers do, and RECORDS what Nodal sent
// (the multipart fields, the model, the audio bytes, the headers), so a test
// asserts on the request itself.
//
//   GET  <prefix>/models                 { object: 'list', data: [{ id }] }   (404 when `models: 'none'`)
//   POST <prefix>/audio/transcriptions   multipart `file` + `model` → { text }
//   POST <prefix>/audio/speech           JSON { model, input, voice, response_format } → audio/wav
//
// Variants: a server that asks for a key (401 without it), lists no models,
// writes back other words, or is not there at all (`closedServerAddress`).
// The server never outlives its test: `close()` in an `afterEach`.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedSpeechRequest {
  method: string;
  /** The path as received, prefix included (`/v1/audio/transcriptions`). */
  path: string;
  /** Lowercased header names. */
  headers: Record<string, string>;
  /** The raw body. */
  body: Uint8Array;
  /** The multipart fields of a transcription, when the body is multipart. */
  form?: {
    model: string | null;
    file: { name: string; type: string; bytes: Uint8Array } | null;
    /** Every field name the form carried, in order. */
    fields: string[];
  };
  /** The JSON body of a speech request, when it is JSON. */
  json?: unknown;
}

export interface FakeSpeechServerOptions {
  /** The path the routes hang off. Default `/v1`. */
  prefix?: string;
  /** The ids `/models` lists, or `'none'` for a server with no such route (404). */
  models?: readonly string[] | 'none';
  /** When set, every route answers 401 without `authorization: Bearer <key>`. */
  key?: string;
  /** What `/audio/transcriptions` writes back. Default `OK.` */
  transcript?: string;
  /** Status `/audio/speech` answers with (default 200), for a refusing server. */
  speechStatus?: number;
}

export interface FakeSpeechServer {
  /** The address a user would type: `http://127.0.0.1:<port><prefix>`. */
  address: string;
  /** Every request received, in order. */
  requests: RecordedSpeechRequest[];
  /** The WAV bytes `/audio/speech` answers. */
  speechWav: Uint8Array;
  close(): Promise<void>;
}

/** A short WAV (16-bit mono PCM, 16 kHz, 0.1 s of a ramp), as a server answers. */
export function tinyWav(sampleRate = 16_000, samples = 1_600): Uint8Array {
  const data = samples * 2;
  const out = new Uint8Array(44 + data);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, data, true);
  for (let i = 0; i < samples; i++) v.setInt16(44 + i * 2, (i % 200) * 100 - 10_000, true);
  return out;
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for await (const chunk of req) parts.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(parts));
}

function headersOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/** The multipart fields, read by the platform's own parser (undici's `Request.formData`). */
async function parseForm(
  headers: Record<string, string>,
  body: Uint8Array,
): Promise<RecordedSpeechRequest['form']> {
  const form = await new Request('http://local/form', {
    method: 'POST',
    headers: { 'content-type': headers['content-type'] ?? '' },
    body: new Uint8Array(body),
  }).formData();
  const file = form.get('file');
  const model = form.get('model');
  return {
    model: typeof model === 'string' ? model : null,
    file:
      file && typeof file !== 'string'
        ? {
            name: (file as File).name,
            type: file.type,
            bytes: new Uint8Array(await file.arrayBuffer()),
          }
        : null,
    fields: [...form.keys()],
  };
}

export async function startFakeSpeechServer(
  opts: FakeSpeechServerOptions = {},
): Promise<FakeSpeechServer> {
  const prefix = opts.prefix ?? '/v1';
  const requests: RecordedSpeechRequest[] = [];
  const speechWav = tinyWav();
  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const headers = headersOf(req);
      const path = (req.url ?? '').split('?')[0]!;
      const rec: RecordedSpeechRequest = { method: req.method ?? '', path, headers, body };
      requests.push(rec);
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (opts.key !== undefined && headers['authorization'] !== `Bearer ${opts.key}`) {
        json(401, { error: { message: 'Invalid API key' } });
        return;
      }
      if (req.method === 'GET' && path === `${prefix}/models`) {
        if (opts.models === 'none') {
          json(404, { detail: 'Not Found' });
          return;
        }
        json(200, {
          object: 'list',
          data: (opts.models ?? []).map((id) => ({ id, object: 'model', owned_by: 'local' })),
        });
        return;
      }
      if (req.method === 'POST' && path === `${prefix}/audio/transcriptions`) {
        if (!(headers['content-type'] ?? '').startsWith('multipart/form-data')) {
          // As a server of the OpenAI surface does: a JSON body is not a form.
          json(422, { detail: 'expected multipart/form-data with a file field' });
          return;
        }
        rec.form = await parseForm(headers, body);
        if (!rec.form?.file || !rec.form.model) {
          json(422, { detail: 'file and model are required' });
          return;
        }
        json(200, { text: opts.transcript ?? 'OK.' });
        return;
      }
      if (req.method === 'POST' && path === `${prefix}/audio/speech`) {
        try {
          rec.json = JSON.parse(Buffer.from(body).toString('utf8'));
        } catch {
          json(422, { detail: 'expected JSON' });
          return;
        }
        if ((opts.speechStatus ?? 200) !== 200) {
          json(opts.speechStatus!, { error: { message: 'voice not found' } });
          return;
        }
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(Buffer.from(speechWav));
        return;
      }
      json(404, { detail: 'Not Found' });
    })().catch((err: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    address: `http://127.0.0.1:${port}${prefix}`,
    requests,
    speechWav,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** An address where nothing listens: a port taken, then released. */
export async function closedServerAddress(prefix = '/v1'): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}${prefix}`;
}

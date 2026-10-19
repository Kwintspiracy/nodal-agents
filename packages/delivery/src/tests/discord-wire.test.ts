// discord-wire.test.ts — the Discord adapter through the REAL discord.js REST
// client (and the undici it ships) against a local HTTP server. Unlike
// discord-adapter.test.ts / button-card.test.ts, nothing from the SDK is spied
// or faked: what is asserted is what the server RECEIVES (method, path,
// headers, JSON body) and how its answers (4xx JSON, 429) come back out of the
// adapter. A discord.js release that changed the REST option shape or the wire
// payload turns these red; the SDK-boundary tests cannot.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { discordAdapter } from '../channels/discord-adapter.ts';

interface Seen {
  method: string;
  path: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

let server: Server;
let creds: Record<string, string>;
let seen: Seen[];
let respond: (req: Seen, res: ServerResponse, attempt: number) => void;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(res: ServerResponse, status: number, payload: unknown, headers = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const entry: Seen = {
        method: req.method ?? '',
        path: req.url ?? '',
        authorization: req.headers['authorization'],
        contentType: req.headers['content-type'],
        body: raw ? (JSON.parse(raw) as unknown) : undefined,
      };
      seen.push(entry);
      respond(entry, res, seen.length);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  creds = { botToken: 'TOK123', apiBaseUrl: `http://127.0.0.1:${port}/api` };
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  seen = [];
  respond = (_req, res) => json(res, 200, { id: 'M1', channel_id: 'C9', content: '' });
});

describe('Discord adapter on the wire @cap:parler-par-canal-externe/moteur', () => {
  it('sendText POSTs the content with the bot auth header and a mass-ping-proof allowed_mentions', async () => {
    const r = await discordAdapter.sendText(creds, 'C9', 'hello @everyone');
    expect(r).toEqual({ messageId: 'M1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      path: '/api/v10/channels/C9/messages',
      authorization: 'Bot TOK123',
      contentType: expect.stringContaining('application/json') as string,
      body: { content: 'hello @everyone', allowed_mentions: { parse: ['users'] } },
    });
  });

  it('sendText splits a long text into several POSTs, in order', async () => {
    await discordAdapter.sendText(creds, 'C9', 'a'.repeat(2000) + 'b'.repeat(10));
    expect(seen.map((s) => s.method)).toEqual(['POST', 'POST']);
    const contents = seen.map((s) => (s.body as { content: string }).content);
    expect(contents.join('')).toBe('a'.repeat(2000) + 'b'.repeat(10));
    expect(contents[0]!.length).toBeLessThanOrEqual(2000);
  });

  it('sendCard POSTs one action row per button row, buttons carrying label and custom_id, nobody pinged', async () => {
    await discordAdapter.sendCard!(creds, 'C9', {
      text: 'Q?',
      buttons: [
        [{ label: 'Yes', callbackData: 'eli:x:y' }],
        [
          { label: 'No', callbackData: 'eli:x:n' },
          { label: 'Later', callbackData: 'eli:x:l' },
        ],
      ],
    });
    const body = seen[0]!.body as {
      content: string;
      allowed_mentions: unknown;
      components: { type: number; components: Record<string, unknown>[] }[];
    };
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/api/v10/channels/C9/messages' });
    expect(body.content).toBe('Q?');
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.components.map((row) => row.type)).toEqual([1, 1]);
    expect(
      body.components.map((row) =>
        row.components.map((b) => ({ type: b['type'], label: b['label'], id: b['custom_id'] })),
      ),
    ).toEqual([
      [{ type: 2, label: 'Yes', id: 'eli:x:y' }],
      [
        { type: 2, label: 'No', id: 'eli:x:n' },
        { type: 2, label: 'Later', id: 'eli:x:l' },
      ],
    ]);
  });

  it('editMessageText PATCHes the message and removes the buttons when none are given', async () => {
    const r = await discordAdapter.editMessageText!(creds, 'C9', 'M7', 'Done');
    expect(r).toEqual({ ok: true });
    expect(seen[0]).toMatchObject({
      method: 'PATCH',
      path: '/api/v10/channels/C9/messages/M7',
      authorization: 'Bot TOK123',
      body: { content: 'Done', allowed_mentions: { parse: [] }, components: [] },
    });
  });

  it('editMessageText rewrites the buttons it is given', async () => {
    await discordAdapter.editMessageText!(creds, 'C9', 'M7', 'Pick', [
      [{ label: 'A', callbackData: 'k:a' }],
    ]);
    const body = seen[0]!.body as { components: { components: { custom_id: string }[] }[] };
    expect(body.components[0]!.components[0]!.custom_id).toBe('k:a');
  });

  it('a Discord 4xx JSON error comes out as a send_failed DeliveryError with status, code and message, token redacted', async () => {
    respond = (_req, res) => json(res, 403, { code: 50013, message: 'Missing Permissions TOK123' });
    await expect(discordAdapter.sendText(creds, 'C9', 'x')).rejects.toMatchObject({
      code: 'send_failed',
      message: expect.stringMatching(/403.*50013.*Missing Permissions \[REDACTED\]/) as string,
    });
  });

  it('a failed edit is reported, never thrown', async () => {
    respond = (_req, res) => json(res, 404, { code: 10008, message: 'Unknown Message' });
    const r = await discordAdapter.editMessageText!(creds, 'C9', 'M7', 'x');
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ error: expect.stringContaining('Unknown Message') as string });
  });

  it('a 429 with retry-after is waited out by the SDK and the same payload is re-sent', async () => {
    respond = (_req, res, attempt) =>
      attempt === 1
        ? json(
            res,
            429,
            { message: 'You are being rate limited.', retry_after: 0.05, global: false },
            { 'retry-after': '0.05', 'x-ratelimit-scope': 'user' },
          )
        : json(res, 200, { id: 'M2' });
    const r = await discordAdapter.sendText(creds, 'C9', 'again');
    expect(r).toEqual({ messageId: 'M2' });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.body).toEqual(seen[0]!.body);
  });

  it('validateCredentials GETs /users/@me and maps 401 to discord_invalid_token', async () => {
    respond = (_req, res, attempt) =>
      attempt === 1
        ? json(res, 200, { id: 'B1', username: 'bot', global_name: 'The Bot' })
        : json(res, 401, { code: 0, message: '401: Unauthorized' });
    await expect(discordAdapter.validateCredentials!(creds)).resolves.toEqual({
      id: 'B1',
      username: 'bot',
      displayName: 'The Bot',
    });
    expect(seen[0]).toMatchObject({ method: 'GET', path: '/api/v10/users/@me' });
    await expect(discordAdapter.validateCredentials!(creds)).rejects.toMatchObject({
      code: 'discord_invalid_token',
    });
  });
});

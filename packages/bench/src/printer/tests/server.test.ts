// server.test.ts — l'imprimante du banc (#794), jouée par un VRAI client MCP.
//
// Le serveur est lancé comme le runner le lance, depuis sa déclaration
// (`benchPrinterServer` : commande, arguments, environnement), et parlé par le
// SDK officiel sur un vrai tube stdio. Rien n'est simulé : ce que ces tests lisent,
// c'est ce que le serveur a ÉCRIT dans son dossier, et ce qu'il a RENDU au client.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixturePath } from '../../workflows/fixtures';
import { readPdf } from '../../workflows/office';
import { PRINT_FILE_REL } from '../../workflows/scenarios';
import { play } from '../../workflows/tests/harness';
import { benchPrinterServer } from '../declaration';
import { BENCH_PRINTER_RECORDS_ENV } from '../identity';
import { readRecords } from '../record';

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

interface Reply {
  readonly isError: boolean;
  readonly text: string;
  readonly structured: Record<string, unknown> | null;
}

let work: string;
let recordsDir: string;
let client: Client;

/** Lance le serveur pour `dir` comme la déclaration le dit, et s'y connecte. */
async function connect(dir: string): Promise<Client> {
  const d = benchPrinterServer(dir);
  const c = new Client({ name: 'bench-printer-test', version: '0.0.0' });
  await c.connect(new StdioClientTransport({ command: d.command, args: d.args, env: d.envVars }));
  return c;
}

async function call(name: string, args: Record<string, unknown>): Promise<Reply> {
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
  };
  return {
    isError: r.isError === true,
    text: (r.content ?? []).map((b) => b.text ?? '').join('\n'),
    structured: r.structuredContent ?? null,
  };
}

const request = (args: Record<string, unknown>): Promise<Reply> => call('request_print', args);

// One server for the file: starting a tsx process costs seconds on a loaded
// Windows runner. The server keeps nothing in memory (it reads its folder at
// every call), so emptying the folder between tests is a clean slate.
beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'bench-printer-work-'));
  recordsDir = mkdtempSync(join(tmpdir(), 'bench-printer-records-'));
  client = await connect(recordsDir);
});
afterAll(async () => {
  await client.close();
  rmSync(work, { recursive: true, force: true });
  rmSync(recordsDir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const name of readdirSync(recordsDir)) rmSync(join(recordsDir, name), { force: true });
});

describe('the bench printer, through a real MCP client over stdio', () => {
  it('offers request_print and get_print_request, and no tool that confirms', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['get_print_request', 'request_print']);
  });

  it('a request for a file records exactly that file: its bytes and their sha-256', async () => {
    const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7 + 3) % 256));
    const path = join(work, 'a.bin');
    writeFileSync(path, bytes);

    const reply = await request({ filePath: path });
    expect(reply.isError).toBe(false);
    expect(reply.structured).toMatchObject({ status: 'pending', received: { bytes: 4096 } });

    const read = readRecords(recordsDir);
    expect(read.problems).toEqual([]);
    expect(read.requests).toHaveLength(1);
    const { record, bytes: received } = read.requests[0]!;
    expect(record.id).toBe(reply.structured!['id']);
    expect(received.equals(bytes)).toBe(true);
    expect(record.bytes).toEqual({ size: 4096, sha256: sha(bytes) });
    expect(record.source).toEqual({ kind: 'file', path });
    expect(record.arguments).toEqual({ filePath: path });
    expect(record.status).toBe('pending');
    expect(Math.abs(record.receivedAtMs - Date.now())).toBeLessThan(60_000);
    expect(record.receivedAt).toBe(new Date(record.receivedAtMs).toISOString());
  });

  it('a PDF is counted by pdf-parse: the pages it would print are the pages of the file', async () => {
    const path = fixturePath('office/facture-bench.pdf');
    const reply = await request({ filePath: path });
    const expected = (await readPdf(path)).pages;
    expect(reply.structured).toMatchObject({ preview: { pages: expected, pagesBasis: 'pdf' } });
    const { record, bytes } = readRecords(recordsDir).requests[0]!;
    expect(record.pages).toBe(expected);
    expect(record.pagesBasis).toBe('pdf');
    expect(record.images).toBeNull();
    expect(bytes.equals(readFileSync(path))).toBe(true);
    expect(record.bytes.sha256).toBe(sha(readFileSync(path)));
  });

  it('a file whose pages the printer cannot count says so: no page count, a warning, never a guessed 1', async () => {
    const path = join(work, 'broken.pdf');
    writeFileSync(path, '%PDF-1.4 this is not a pdf');
    const reply = await request({ filePath: path });
    expect(reply.isError).toBe(false);
    expect(reply.structured).toMatchObject({ preview: { pages: null, pagesBasis: 'unknown' } });
    expect(reply.structured!['warnings']).toEqual([
      expect.stringContaining('the PDF could not be read to count its pages'),
    ]);
    const { record } = readRecords(recordsDir).requests[0]!;
    expect(record.pages).toBeNull();
    expect(record.pagesBasis).toBe('unknown');
  });

  it('composed HTML is recorded as received, with the pictures the document references', async () => {
    const html =
      '<h1>Caviar d\'aubergines</h1><img src="https://example.org/a.jpg"><p>œufs</p><img alt="x" src=\'data:image/png;base64,AAAA\'>';
    const reply = await request({ content: html });
    expect(reply.structured).toMatchObject({
      status: 'pending',
      preview: { pages: 1, pagesBasis: 'html-estimate' },
      images: {
        embedded: [
          { origin: 'https://example.org/a.jpg' },
          { origin: 'data:image/png;base64,AAAA' },
        ],
      },
    });
    const { record, bytes } = readRecords(recordsDir).requests[0]!;
    expect(bytes.toString('utf8')).toBe(html);
    expect(record.bytes.sha256).toBe(sha(Buffer.from(html, 'utf8')));
    expect(record.source).toEqual({ kind: 'content', contentFormat: 'html' });
    expect(record.images).toEqual([
      { origin: 'https://example.org/a.jpg' },
      { origin: 'data:image/png;base64,AAAA' },
    ]);
    expect(record.arguments).toEqual({ content: html });
  });

  it('composed HTML with no picture reports an empty list, not "unknown"', async () => {
    const reply = await request({ content: '<h1>Caviar</h1>' });
    expect(reply.structured).toMatchObject({ images: { embedded: [] } });
  });

  it('plain text is estimated by its lines: 200 lines are four pages', async () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const reply = await request({ content: text, format: 'text' });
    expect(reply.structured).toMatchObject({ preview: { pages: 4, pagesBasis: 'text-estimate' } });
    const { record, bytes } = readRecords(recordsDir).requests[0]!;
    expect(bytes.toString('utf8')).toBe(text);
    expect(record.images).toBeNull();
    expect(record.source).toEqual({ kind: 'content', contentFormat: 'text' });
  });

  it('get_print_request reads a request back, pending; an unknown id is an error', async () => {
    const created = await request({ content: '<p>pain</p>' });
    const id = created.structured!['id'] as string;
    const back = await call('get_print_request', { id });
    expect(back.isError).toBe(false);
    expect(back.structured).toMatchObject({ id, status: 'pending' });
    const unknown = await call('get_print_request', { id: 'pr-0-nothing' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('No print request "pr-0-nothing"');
  });

  it('a request stays pending: there is no way to confirm it, and asking for one changes nothing', async () => {
    const created = await request({ content: '<p>pain</p>' });
    const id = created.structured!['id'] as string;
    let refused = false;
    try {
      const r = await call('confirm_print', { id });
      refused = r.isError;
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    const { record } = readRecords(recordsDir).requests[0]!;
    expect(record.status).toBe('pending');
    expect((await call('get_print_request', { id })).structured).toMatchObject({
      status: 'pending',
    });
  });

  it('replaces withdraws the pending request it names, and only then', async () => {
    const first = await request({ content: '<p>first</p>' });
    const firstId = first.structured!['id'] as string;
    const second = await request({ content: '<p>second</p>', replaces: firstId });
    const secondId = second.structured!['id'] as string;
    expect(second.isError).toBe(false);

    const byId = new Map(readRecords(recordsDir).requests.map((r) => [r.record.id, r.record]));
    expect(byId.get(firstId)).toMatchObject({ status: 'replaced', replacedBy: secondId });
    expect(byId.get(secondId)).toMatchObject({ status: 'pending', replacedBy: null });
    expect((await call('get_print_request', { id: firstId })).structured).toMatchObject({
      status: 'replaced',
      replacedBy: secondId,
    });

    // Remplacer une demande déjà retirée, ou inconnue : refusé, aucune demande de plus.
    const again = await request({ content: '<p>third</p>', replaces: firstId });
    const ghost = await request({ content: '<p>fourth</p>', replaces: 'pr-0-nothing' });
    expect([again.isError, ghost.isError]).toEqual([true, true]);
    expect(readRecords(recordsDir).requests).toHaveLength(2);
  });

  it.each([
    ['both a file and content', () => ({ filePath: join(work, 'a.bin'), content: '<p>x</p>' })],
    ['neither a file nor content', () => ({})],
    ['a relative path', () => ({ filePath: 'a.bin' })],
    ['a file that does not exist', () => ({ filePath: join(work, 'nope.pdf') })],
    ['a folder', () => ({ filePath: work })],
    ['a field it does not know', () => ({ content: '<p>x</p>', copies: 2 })],
  ])('refuses %s, and records nothing', async (_label, args) => {
    writeFileSync(join(work, 'a.bin'), 'x');
    let refused = false;
    try {
      refused = (await request(args())).isError;
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(readdirSync(recordsDir)).toEqual([]);
  });

  it('each request is its own record: ids differ, and the folder holds one json and one bytes file per request', async () => {
    const a = await request({ content: '<p>a</p>' });
    const b = await request({ content: '<p>a</p>' });
    expect(a.structured!['id']).not.toBe(b.structured!['id']);
    const names = readdirSync(recordsDir).sort();
    expect(names).toHaveLength(4);
    expect(names.filter((n) => n.endsWith('.json'))).toHaveLength(2);
    expect(names.filter((n) => n.endsWith('.bytes'))).toHaveLength(2);
  });
});

describe('the record the server wrote is what print-file judges', () => {
  const attached = () => ({
    teamTools: ['bench_printer__request_print'],
    benchPrinter: { kind: 'attached' as const, recordsDir },
  });

  it('green when the agent has the real server print the posed file', async () => {
    const posed = await play(
      'print-file',
      { tools: [{ name: 'bench_printer__request_print', input: {} }] },
      async (root) => {
        const r = await request({ filePath: join(root, PRINT_FILE_REL) });
        expect(r.isError).toBe(false);
      },
      attached(),
    );
    expect(posed.reasons).toEqual([]);
  });

  it('red when the agent has the real server print another file', async () => {
    const other = await play(
      'print-file',
      { tools: [{ name: 'bench_printer__request_print', input: {} }] },
      async (root) => {
        // Un autre fichier que le posé : le serveur reçoit ses octets, pas ceux de la fixture.
        const path = join(root, 'nodal-bench', 'autre.pdf');
        writeFileSync(path, '%PDF-1.4 another invoice');
        const r = await request({ filePath: path });
        expect(r.isError).toBe(false);
      },
      attached(),
    );
    expect(other.reasons).toEqual([
      expect.stringMatching(
        /^the content the bench printer received is not the posed file \(sha-256 [0-9a-f]{12}, expected [0-9a-f]{12}\)$/,
      ),
    ]);
  });
});

describe('the bench printer server process', () => {
  it('refuses to start without a record folder: it invents none', () => {
    const d = benchPrinterServer(join(tmpdir(), 'x'));
    const env = { ...process.env };
    delete env[BENCH_PRINTER_RECORDS_ENV];
    const r = spawnSync(d.command, d.args, {
      env,
      encoding: 'utf8',
      timeout: 60_000,
      input: '',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('bench_printer_records_dir_missing');
  });

  it('creates its record folder at start when it is missing', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'bench-printer-parent-'));
    const dir = join(parent, 'deep', 'records');
    const c = await connect(dir);
    try {
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      await c.close();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('keeps the records of a folder across restarts of the server', async () => {
    const created = await request({ content: '<p>pain</p>' });
    const first = client;
    client = await connect(recordsDir);
    try {
      const id = created.structured!['id'] as string;
      expect((await call('get_print_request', { id })).structured).toMatchObject({
        id,
        status: 'pending',
      });
    } finally {
      await client.close();
      client = first;
    }
  });
});

// print-wait.test.ts — l'imprimante du banc qui IMPRIME, et son attente (#1071).
//
// Le serveur est lancé comme le runner le lance, depuis sa déclaration
// (`benchPrinterServer(dir, { printSeconds })`), et parlé par le SDK officiel
// sur un vrai tube stdio, avec un `onprogress` : le client demande donc des
// notifications de progression, comme le client MCP de Nodal le fait
// (adapters/mcp/src/tools.ts, la borne de l'appel relancée à chaque
// notification). Rien n'est simulé : les états lus sont ceux que le serveur
// RENDS, les notifications celles qu'il a ENVOYÉES, l'enregistrement celui
// qu'il a ÉCRIT.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { benchPrinterServer } from '../declaration';
import {
  BENCH_PRINTER_PRINT_SECONDS_ENV,
  BENCH_PRINTER_RECORDS_ENV,
  benchPrinterState,
} from '../identity';
import { readRecords } from '../record';

/** Le temps qu'un travail met à sortir, sur cette imprimante. */
const PRINT_SECONDS = 2;

interface Reply {
  readonly isError: boolean;
  readonly text: string;
  readonly structured: Record<string, unknown> | null;
  readonly progress: Array<{ progress: number; total?: number; message?: string }>;
  readonly elapsedMs: number;
}

async function connect(dir: string, printSeconds: number | null): Promise<Client> {
  const d = benchPrinterServer(dir, { printSeconds });
  const c = new Client({ name: 'bench-printer-wait-test', version: '0.0.0' });
  await c.connect(new StdioClientTransport({ command: d.command, args: d.args, env: d.envVars }));
  return c;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Reply> {
  const progress: Reply['progress'] = [];
  const t0 = Date.now();
  const r = (await client.callTool({ name, arguments: args }, undefined, {
    onprogress: (p) => progress.push(p),
    timeout: 60_000,
  })) as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
  };
  return {
    isError: r.isError === true,
    text: (r.content ?? []).map((b) => b.text ?? '').join('\n'),
    structured: r.structuredContent ?? null,
    progress,
    elapsedMs: Date.now() - t0,
  };
}

let printingDir: string;
let waitingDir: string;
let printing: Client;
let waiting: Client;

beforeAll(async () => {
  printingDir = mkdtempSync(join(tmpdir(), 'bench-printer-prints-'));
  waitingDir = mkdtempSync(join(tmpdir(), 'bench-printer-waits-'));
  [printing, waiting] = await Promise.all([
    connect(printingDir, PRINT_SECONDS),
    connect(waitingDir, null),
  ]);
}, 60_000);
afterAll(async () => {
  await Promise.all([printing.close(), waiting.close()]);
  rmSync(printingDir, { recursive: true, force: true });
  rmSync(waitingDir, { recursive: true, force: true });
});

describe('the bench printer that prints: a submitted job followed to its end', () => {
  it('says in its tools that a job can be followed, and a request is accepted, not printed', async () => {
    const tools = (await printing.listTools()).tools;
    const status = tools.find((t) => t.name === 'get_print_request')!;
    expect(status.description).toContain('Give waitSeconds to follow it to its end');
    expect(Object.keys(status.inputSchema.properties ?? {}).sort()).toEqual(['id', 'waitSeconds']);

    const sent = await call(printing, 'request_print', { content: '<p>pain</p>' });
    expect(sent.isError).toBe(false);
    expect(sent.structured).toMatchObject({ status: 'accepted', pagesOut: 0 });
    expect(sent.text).toContain('Not printed yet.');
    // L'enregistrement : un travail soumis, avec sa durée.
    const id = sent.structured!['id'] as string;
    const rec = readRecords(printingDir).requests.find((r) => r.record.id === id)!.record;
    expect(rec).toMatchObject({ status: 'submitted', printMs: PRINT_SECONDS * 1000 });
  });

  it('without a wait, answers at once with the state now: not completed yet', async () => {
    const sent = await call(printing, 'request_print', { content: '<p>lait</p>' });
    const id = sent.structured!['id'] as string;
    const now = await call(printing, 'get_print_request', { id });
    expect(now.isError).toBe(false);
    expect(['accepted', 'printing']).toContain(now.structured!['status']);
    expect(now.structured!['pagesOut']).toBe(0);
    expect(now.progress).toEqual([]);
    expect(now.elapsedMs).toBeLessThan(PRINT_SECONDS * 1000);
  });

  it('a wait long enough returns completed, the pages out, with progress notifications on the way', async () => {
    const sent = await call(printing, 'request_print', { content: '<p>beurre</p>' });
    const id = sent.structured!['id'] as string;
    const done = await call(printing, 'get_print_request', { id, waitSeconds: 20 });
    expect(done.isError).toBe(false);
    expect(done.structured).toMatchObject({ id, status: 'completed', pagesOut: 1 });
    expect(done.text).toContain(`Print job ${id} is completed: 1 page printed.`);
    // It returned when the job ended, not at the end of the wait.
    expect(done.elapsedMs).toBeLessThan(10_000);
    // Real MCP progress notifications, one per second while printing, saying the state.
    expect(done.progress.length).toBeGreaterThanOrEqual(1);
    expect(done.progress[0]).toMatchObject({ total: 20 });
    expect(done.progress[0]!.message).toMatch(
      new RegExp(`^Print job ${id} is (accepted|printing)\\.$`),
    );
    const values = done.progress.map((p) => p.progress);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });

  it('a wait too short returns the job still in progress, said so: not printed yet', async () => {
    const sent = await call(printing, 'request_print', { content: '<p>sel</p>' });
    const id = sent.structured!['id'] as string;
    const short = await call(printing, 'get_print_request', { id, waitSeconds: 0.5 });
    expect(short.isError).toBe(false);
    expect(['accepted', 'printing']).toContain(short.structured!['status']);
    expect(short.text).toContain('Not printed yet.');
    expect(short.elapsedMs).toBeGreaterThanOrEqual(400);
    expect(short.elapsedMs).toBeLessThan(PRINT_SECONDS * 1000);
  });

  it('a job sent to the printer cannot be replaced: refused, nothing more is printed', async () => {
    const sent = await call(printing, 'request_print', { content: '<p>a</p>' });
    const before = readRecords(printingDir).requests.length;
    const again = await call(printing, 'request_print', {
      content: '<p>b</p>',
      replaces: sent.structured!['id'],
    });
    expect(again.isError).toBe(true);
    expect(again.text).toContain('cannot be replaced');
    expect(readRecords(printingDir).requests).toHaveLength(before);
  });
});

describe('the bench printer that waits for the owner: nothing to follow', () => {
  it('a wait on a request that waits for the owner returns at once, still pending', async () => {
    const sent = await call(waiting, 'request_print', { content: '<p>pain</p>' });
    expect(sent.structured).toMatchObject({ status: 'pending' });
    expect(sent.structured).not.toHaveProperty('pagesOut');
    const back = await call(waiting, 'get_print_request', {
      id: sent.structured!['id'],
      waitSeconds: 30,
    });
    expect(back.structured).toMatchObject({ status: 'pending' });
    expect(back.text).toContain('Nothing was printed.');
    expect(back.progress).toEqual([]);
    expect(back.elapsedMs).toBeLessThan(5_000);
  });
});

describe('the declaration of a printer that prints is the identity the judge checks', () => {
  const dir = join(tmpdir(), 'bench-printer-identity-1071');
  const row = (env: Record<string, string>) => {
    const d = benchPrinterServer(dir);
    return { slug: d.slug, transport: d.transport, command: d.command, args: d.args, envVars: env };
  };

  it('without printSeconds the declaration is the one before #1071, field for field', () => {
    expect(Object.keys(benchPrinterServer(dir).envVars)).toEqual([BENCH_PRINTER_RECORDS_ENV]);
    expect(benchPrinterServer(dir, { printSeconds: 3 }).envVars).toEqual({
      [BENCH_PRINTER_RECORDS_ENV]: dir,
      [BENCH_PRINTER_PRINT_SECONDS_ENV]: '3',
    });
  });

  it('a row declaring a print time is attached; an unreadable one is broken, said', () => {
    expect(
      benchPrinterState(
        [row({ [BENCH_PRINTER_RECORDS_ENV]: dir, [BENCH_PRINTER_PRINT_SECONDS_ENV]: '3' })],
        benchPrinterServer,
      ),
    ).toEqual({ kind: 'attached', recordsDir: dir });
    const bad = benchPrinterState(
      [row({ [BENCH_PRINTER_RECORDS_ENV]: dir, [BENCH_PRINTER_PRINT_SECONDS_ENV]: 'soon' })],
      benchPrinterServer,
    );
    expect(bad.kind).toBe('broken');
    expect(bad.kind === 'broken' && bad.reason).toContain(
      `${BENCH_PRINTER_PRINT_SECONDS_ENV}="soon" is not a number of seconds`,
    );
  });
});

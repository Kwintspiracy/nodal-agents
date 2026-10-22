// identity.test.ts — qui est l'imprimante du banc (#794), lue comme le produit la déclare.
//
// L'identité est le SLUG du serveur et le dossier que sa déclaration porte,
// jamais le nom d'un outil. La déclaration de la base est jouée sur PGlite avec
// le schéma des tests de @nodal-agents/db, comme l'équipe réelle d'un espace.

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { seedMinimal, spinUpTestDb } from '@nodal-agents/db/test-utils';
import { readBenchPrinter, readTeamTools } from '../../workflows/stack';
import { benchPrinterServer } from '../declaration';
import {
  BENCH_PRINTER_RECORDS_ENV,
  BENCH_PRINTER_SLUG,
  benchPrinterState,
  isBenchPrinterTool,
} from '../identity';

const DIR = join(process.cwd(), 'records');

describe('isBenchPrinterTool: the identity of the server, not the name of a tool', () => {
  it.each([
    ['bench_printer__request_print', true],
    ['bench_printer__get_print_request', true],
    // Le même nom d'outil, un autre serveur : un connecteur réel. Sortant.
    ['office_printer__request_print', false],
    ['printer__request_print', false],
    ['request_print', false],
    // Un outil que le serveur du banc n'expose pas.
    ['bench_printer__confirm_print', false],
    ['bench_printer__list_printers', false],
    // Le préfixe d'un autre serveur qui lui ressemble.
    ['bench_printer_two__request_print', false],
    ['xbench_printer__request_print', false],
  ])('%s → %s', (name, expected) => {
    expect(isBenchPrinterTool(name)).toBe(expected);
  });
});

describe('benchPrinterServer: the one declaration the instance wires', () => {
  it('names a stdio server that the runner can launch: the bench Node, its tsx and the entry file', () => {
    const d = benchPrinterServer(DIR);
    expect(d).toMatchObject({
      slug: BENCH_PRINTER_SLUG,
      transport: 'stdio',
      command: process.execPath,
      envVars: { [BENCH_PRINTER_RECORDS_ENV]: DIR },
    });
    expect(d.args).toHaveLength(2);
    expect(d.args.every((a) => isAbsolute(a) && existsSync(a))).toBe(true);
    expect(d.args[1]).toMatch(/printer[\\/]main\.ts$/);
  });

  it('refuses a relative record folder: the runner launches it from another folder', () => {
    expect(() => benchPrinterServer('records')).toThrow('bench_printer_records_dir_not_absolute');
  });
});

describe('benchPrinterState: what the declarations of the team say', () => {
  const server = (over: Partial<Parameters<typeof benchPrinterState>[0][number]> = {}) => ({
    slug: BENCH_PRINTER_SLUG,
    transport: 'stdio',
    envVars: { [BENCH_PRINTER_RECORDS_ENV]: DIR },
    ...over,
  });

  it('is absent when no server of that slug is attached', () => {
    expect(benchPrinterState([])).toEqual({ kind: 'absent' });
    expect(benchPrinterState([server({ slug: 'office-printer' })])).toEqual({ kind: 'absent' });
  });

  it('is attached with the folder the declaration carries', () => {
    expect(benchPrinterState([server()])).toEqual({ kind: 'attached', recordsDir: DIR });
    // Le même serveur attribué à deux agents : un seul dossier, attaché.
    expect(benchPrinterState([server(), server()])).toEqual({ kind: 'attached', recordsDir: DIR });
  });

  it.each([
    ['an http transport', server({ transport: 'http' }), 'declared with transport http'],
    ['no environment', server({ envVars: null }), `declares no ${BENCH_PRINTER_RECORDS_ENV}`],
    ['an empty folder', server({ envVars: { [BENCH_PRINTER_RECORDS_ENV]: ' ' } }), 'declares no'],
    [
      'a folder that is not a string',
      server({ envVars: { [BENCH_PRINTER_RECORDS_ENV]: 7 } }),
      'declares no',
    ],
  ])('is broken, with its reason, when the server has %s', (_label, s, reason) => {
    const st = benchPrinterState([s]);
    expect(st).toMatchObject({ kind: 'broken' });
    expect((st as { reason: string }).reason).toContain(reason);
  });

  it('is broken when two declarations name different folders: the judge cannot pick one', () => {
    const st = benchPrinterState([
      server(),
      server({ envVars: { [BENCH_PRINTER_RECORDS_ENV]: join(DIR, 'other') } }),
    ]);
    expect(st).toMatchObject({ kind: 'broken' });
    expect((st as { reason: string }).reason).toContain('2 different record folders');
  });
});

describe('readBenchPrinter: from the team of a workspace', () => {
  let pg: Awaited<ReturnType<typeof spinUpTestDb>>['pg'];
  let db: AnyDrizzleDb;
  let entityId: string;
  let agentId: string;

  beforeAll(async () => {
    const t = await spinUpTestDb();
    pg = t.pg;
    db = t.db as unknown as AnyDrizzleDb;
    const seed = await seedMinimal(t.db);
    entityId = seed.entityId;
    agentId = seed.agentId;
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    await pg.exec('delete from agent_mcp_servers; delete from mcp_servers;');
    await pg.query(`update agents set active = true`);
  });

  /** Déclare le serveur comme la déclaration du banc le déclare, et l'attribue (ou non). */
  async function declare(
    over: { slug?: string; transport?: string; active?: boolean; assigned?: boolean } = {},
  ) {
    const d = benchPrinterServer(DIR);
    const s = await pg.query<{ id: string }>(
      `insert into mcp_servers (entity_id, name, slug, transport, command, args, env_vars, active, available_tools)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb) returning id::text`,
      [
        entityId,
        d.name,
        over.slug ?? d.slug,
        over.transport ?? d.transport,
        d.command,
        d.args,
        JSON.stringify(d.envVars),
        over.active ?? true,
        JSON.stringify([{ name: 'request_print' }, { name: 'get_print_request' }]),
      ],
    );
    if (over.assigned !== false) {
      await pg.query(
        `insert into agent_mcp_servers (entity_id, agent_id, mcp_server_id) values ($1, $2, $3)`,
        [entityId, agentId, s.rows[0]!.id],
      );
    }
  }

  it('is absent when nothing is attached', async () => {
    expect(await readBenchPrinter(db, entityId)).toEqual({ kind: 'absent' });
  });

  it('is attached, with the folder of the declaration, when an active agent holds the server', async () => {
    await declare();
    expect(await readBenchPrinter(db, entityId)).toEqual({ kind: 'attached', recordsDir: DIR });
    // Et le produit nomme ses outils comme le juge les reconnaît.
    const tools = await readTeamTools(db, entityId);
    expect(tools).toContain('bench_printer__request_print');
    expect(tools.filter(isBenchPrinterTool)).toEqual([
      'bench_printer__get_print_request',
      'bench_printer__request_print',
    ]);
  });

  it('is absent when the server exists but no agent holds it', async () => {
    await declare({ assigned: false });
    expect(await readBenchPrinter(db, entityId)).toEqual({ kind: 'absent' });
  });

  it('is absent when the only agent holding it is inactive, or the server is switched off', async () => {
    await declare();
    await pg.query(`update agents set active = false`);
    expect(await readBenchPrinter(db, entityId)).toEqual({ kind: 'absent' });
    await pg.query(`update agents set active = true`);
    await pg.query(`update mcp_servers set active = false`);
    expect(await readBenchPrinter(db, entityId)).toEqual({ kind: 'absent' });
  });

  it('is broken when a server of that slug is declared over http', async () => {
    await declare({ transport: 'http' });
    expect(await readBenchPrinter(db, entityId)).toMatchObject({ kind: 'broken' });
  });

  it('does not take another server for the bench printer, whatever its tools are called', async () => {
    await declare({ slug: 'office-printer' });
    expect(await readBenchPrinter(db, entityId)).toEqual({ kind: 'absent' });
  });
});

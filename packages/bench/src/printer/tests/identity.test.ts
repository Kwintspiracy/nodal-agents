// identity.test.ts — qui est l'imprimante du banc (#794), lue comme le produit la déclare.
//
// L'identité est la DÉCLARATION entière du serveur (transport, commande,
// arguments, environnement : ce que `benchPrinterServer(dossier)` rend), jamais
// un slug, une variable d'environnement ou le nom d'un outil. La déclaration de la
// base est jouée sur PGlite avec le schéma des tests de @nodal-agents/db, comme
// l'équipe réelle d'un espace.

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { seedMinimal, spinUpTestDb } from '@nodal-agents/db/test-utils';
import {
  _resetMasterKeyCacheForTests,
  _setMasterKeyForTests,
  encrypt,
} from '@nodal-agents/secrets';
import { readBenchPrinter, readTeamMcpServers, readTeamTools } from '../../workflows/stack';
import { benchPrinterServer } from '../declaration';
import {
  BENCH_PRINTER_RECORDS_ENV,
  BENCH_PRINTER_SLUG,
  benchPrinterState,
  isBenchPrinterTool,
  type AttachedMcpServer,
} from '../identity';

const DIR = join(process.cwd(), 'records');
const REAL_SERVICE = '/usr/bin/real-print-service';

describe('isBenchPrinterTool: the tools of the bench printer, by their prefix', () => {
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

// La déclaration est écrite par le CLI (campaign/apply.ts) et relue par le
// Studio (stack.ts `readBenchPrinter`), qui la recalcule pour comparer. Les deux
// doivent tomber sur les MÊMES chemins : l'identité de l'imprimante en dépend
// (revue de #866, passe 1). Ce que le CLI résout se lit depuis son entrée, comme
// Node le fait quand `pnpm bench:campaign` lance `tsx src/campaign/cli.ts`.
describe('benchPrinterServer: the same declaration for the CLI that writes it and the Studio that reads it', () => {
  const benchDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const cliEntry = join(benchDir, 'src', 'campaign', 'cli.ts');
  const fromCli = {
    tsx: createRequire(pathToFileURL(cliEntry)).resolve('tsx/cli'),
    main: fileURLToPath(new URL('../printer/main.ts', pathToFileURL(cliEntry))),
  };

  it("resolves tsx and the printer's entry exactly as the CLI entry does", () => {
    expect(existsSync(cliEntry)).toBe(true);
    expect(benchPrinterServer(DIR).args).toEqual([fromCli.tsx, fromCli.main]);
  });

  it('gives the same declaration whatever folder the process starts in', () => {
    const tsxCli = createRequire(pathToFileURL(cliEntry)).resolve('tsx/cli');
    const declaration = pathToFileURL(join(benchDir, 'src', 'printer', 'declaration.ts')).href;
    const script = `import(${JSON.stringify(declaration)}).then((m) => process.stdout.write(JSON.stringify(m.benchPrinterServer(${JSON.stringify(DIR)}))))`;
    const cwd = mkdtempSync(join(tmpdir(), 'bench-declaration-'));
    try {
      const r = spawnSync(process.execPath, [tsxCli, '--eval', script], {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual(benchPrinterServer(DIR));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('benchPrinterState: the identity is the whole declaration', () => {
  /** La ligne que la base garde pour la déclaration du banc, champ pour champ. */
  const row = (over: Partial<AttachedMcpServer> = {}): AttachedMcpServer => {
    const d = benchPrinterServer(DIR);
    return {
      slug: d.slug,
      transport: d.transport,
      command: d.command,
      args: d.args,
      envVars: d.envVars,
      ...over,
    };
  };
  const state = (servers: AttachedMcpServer[], expectedDir: string | null = null) =>
    benchPrinterState(servers, benchPrinterServer, expectedDir);
  const reason = (s: ReturnType<typeof state>): string =>
    s.kind === 'broken' ? s.reason : `(not broken: ${s.kind})`;

  it('is absent when no server of the bench printer prefix is attached', () => {
    expect(state([])).toEqual({ kind: 'absent' });
    expect(state([row({ slug: 'office-printer' })])).toEqual({ kind: 'absent' });
  });

  it("is attached with the folder of a declaration identical to the bench's", () => {
    expect(state([row()])).toEqual({ kind: 'attached', recordsDir: DIR });
    // Le même serveur attribué à deux agents : un seul dossier, attaché.
    expect(state([row(), row()])).toEqual({ kind: 'attached', recordsDir: DIR });
  });

  // Revue de #832, passe 1 (P1) : un connecteur RÉEL déclaré sous le slug du banc,
  // avec la variable d'environnement du dossier, était accepté (besoin rempli,
  // exemption, papier). L'identité est la déclaration entière.
  it.each([
    ['another command', row({ command: REAL_SERVICE }), 'differs in: command'],
    ['other arguments', row({ args: ['--serve', '--real'] }), 'differs in: args'],
    ['no arguments', row({ args: null }), 'differs in: args'],
    ['an http transport', row({ transport: 'http' }), 'differs in: transport http'],
    [
      'an extra environment variable',
      row({ envVars: { [BENCH_PRINTER_RECORDS_ENV]: DIR, PRINTER_HOST: '10.0.0.5' } }),
      'differs in: environment',
    ],
    ['no environment', row({ envVars: null }), `declares no ${BENCH_PRINTER_RECORDS_ENV}`],
    [
      'an empty folder',
      row({ envVars: { [BENCH_PRINTER_RECORDS_ENV]: ' ' } }),
      `declares no ${BENCH_PRINTER_RECORDS_ENV}`,
    ],
    [
      'a relative folder',
      row({ envVars: { [BENCH_PRINTER_RECORDS_ENV]: 'records' } }),
      'bench_printer_records_dir_not_absolute',
    ],
  ])('is broken, with what differs, when the server has %s', (_label, s, why) => {
    const st = state([s]);
    expect(st.kind).toBe('broken');
    expect(reason(st)).toContain(why);
  });

  it.each(['bench_printer', 'Bench-Printer', 'bench.printer'])(
    'a server whose tools the runner names like the bench printer (slug %s) must be the bench printer, or the state is broken',
    (slug) => {
      // Même préfixe d'outil (`bench_printer__request_print`) : sans cette règle, un
      // connecteur réel sous ce slug hériterait de l'exemption.
      const real = state([row({ slug, command: REAL_SERVICE })]);
      expect(real.kind).toBe('broken');
      expect(reason(real)).toContain(`"${slug}"`);
      // La déclaration exacte du banc, mais sous un autre slug : ce n'est pas son serveur.
      const same = state([row({ slug })]);
      expect(same.kind).toBe('broken');
      expect(reason(same)).toContain(`differs in: slug ${slug}`);
    },
  );

  it('is broken when two declarations name different folders: the judge cannot pick one', () => {
    const other = join(DIR, 'other');
    const st = state([row(), row({ envVars: benchPrinterServer(other).envVars })]);
    expect(st.kind).toBe('broken');
    expect(reason(st)).toContain('2 different record folders');
  });

  it('reads only the folder the bench gave: a declaration that records elsewhere is broken', () => {
    const given = join(DIR, 'given');
    expect(state([row()], DIR)).toEqual({ kind: 'attached', recordsDir: DIR });
    const st = state([row()], given);
    expect(st.kind).toBe('broken');
    expect(reason(st)).toContain(`not in ${given}`);
    expect(reason(st)).toContain('the folder the bench gave');
  });
});

describe('readBenchPrinter: from the team of a workspace', () => {
  let pg: Awaited<ReturnType<typeof spinUpTestDb>>['pg'];
  let db: AnyDrizzleDb;
  let entityId: string;
  let agentId: string;

  beforeAll(async () => {
    // Une clé maîtresse de test : jamais celle de la machine.
    _setMasterKeyForTests(randomBytes(32));
    const t = await spinUpTestDb();
    pg = t.pg;
    db = t.db as unknown as AnyDrizzleDb;
    const seed = await seedMinimal(t.db);
    entityId = seed.entityId;
    agentId = seed.agentId;
  });
  afterAll(async () => {
    await pg.close();
    _resetMasterKeyCacheForTests();
  });
  beforeEach(async () => {
    await pg.exec('delete from agent_mcp_servers; delete from mcp_servers;');
    await pg.query(`update agents set active = true`);
  });

  /** Déclare un serveur comme la déclaration du banc le déclare (ou autrement), et l'attribue (ou non). */
  async function declare(
    over: {
      slug?: string;
      transport?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      /** L'environnement tel que la ligne le porte : chiffré valeur par valeur (le produit), ou en clair. */
      envAtRest?: 'encrypted' | 'plain';
      active?: boolean;
      assigned?: boolean;
      tools?: unknown;
    } = {},
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
        over.command ?? d.command,
        over.args ?? d.args,
        JSON.stringify(
          Object.fromEntries(
            Object.entries(over.env ?? d.envVars).map(([k, v]) => [
              k,
              over.envAtRest === 'plain' ? v : encrypt(v),
            ]),
          ),
        ),
        over.active ?? true,
        JSON.stringify(
          over.tools === undefined
            ? [
                { name: 'request_print', inputSchema: {} },
                { name: 'get_print_request', inputSchema: {} },
              ]
            : over.tools,
        ),
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

  // Le runner déchiffre chaque valeur avant de lancer le serveur (execute.ts,
  // `decryptMcpServerEnv`) : le juge lit la même chose. Une ligne écrite en
  // clair, comme le produit ne l'écrit jamais, est un serveur que le runner
  // écarterait ; le juge le dit au lieu de la croire.
  it('reads the environment as the runner does: decrypted, and a value that does not decrypt is broken', async () => {
    await declare({ envAtRest: 'plain' });
    const st = await readBenchPrinter(db, entityId);
    expect(st.kind).toBe('broken');
    expect(st.kind === 'broken' ? st.reason : '').toContain(
      'environment cannot be read as the runner reads it',
    );
    expect(st.kind === 'broken' ? st.reason : '').toContain('the runner would not start it');
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

  // Revue de #832 (P1) : le slug du banc et la variable du dossier ne font pas
  // l'imprimante ; la commande et les arguments non plus s'ils ne sont pas les siens.
  it('is broken, not attached, when a real print service is declared under the bench slug with the folder variable', async () => {
    await declare({ command: REAL_SERVICE, args: ['--serve'] });
    const st = await readBenchPrinter(db, entityId);
    expect(st.kind).toBe('broken');
    expect((st as { reason: string }).reason).toContain('differs in: command, args');
  });

  it('is broken when a real service takes a slug that the runner would prefix like the bench printer', async () => {
    await declare({ slug: 'bench_printer', command: REAL_SERVICE, args: [] });
    expect(await readBenchPrinter(db, entityId)).toMatchObject({ kind: 'broken' });
  });

  it('is broken when the declaration records elsewhere than the folder the bench gave', async () => {
    await declare();
    const given = join(DIR, 'given');
    expect(await readBenchPrinter(db, entityId, DIR)).toEqual({
      kind: 'attached',
      recordsDir: DIR,
    });
    expect(await readBenchPrinter(db, entityId, given)).toMatchObject({ kind: 'broken' });
  });

  it('does not take another server for the bench printer, whatever its tools are called', async () => {
    await declare({ slug: 'office-printer' });
    expect(await readBenchPrinter(db, entityId)).toEqual({ kind: 'absent' });
  });

  it('readTeamMcpServers: the servers with their tool names, null when the cache is unusable', async () => {
    await declare({ slug: 'fetch', tools: [{ name: 'fetch_html', inputSchema: {} }] });
    await declare({ slug: 'mystery', tools: null });
    await declare({ slug: 'old', tools: [{ name: 'a_tool' }] });
    expect(await readTeamMcpServers(db, entityId)).toEqual([
      { slug: 'fetch', tools: ['fetch_html'] },
      { slug: 'mystery', tools: null },
      { slug: 'old', tools: null },
    ]);
  });
});

// add-nodal-to-claude-desktop-action.test.ts — l'action « Ajouter à Claude
// Desktop » (#485), au niveau de l'action : ses trois refus, puis le fichier
// réellement écrit sur le disque.
//
// Le fichier de Claude Desktop appartient à l'utilisateur de la machine, pas à
// un espace de travail : l'action est réservée au propriétaire, sur une install
// à un compte. Sans `NODAL_CLI_ARGV`, elle ne devine aucune commande.
//
// Les cas partagent une base : l'ordre compte, le second compte est ajouté en
// dernier.
//
// Mutations vérifiées :
//   - la garde propriétaire retirée → « un non-propriétaire est refusé »
//     rougit ;
//   - `assertMonoUserHostInstall` retiré de l'action → « une install à
//     plusieurs comptes est refusée » rougit ;
//   - la garde `argv === null` retirée → « sans NODAL_CLI_ARGV, l'action
//     refuse » rougit ;
//   - `claudeDesktopEntry(argv)` remplacé par une entrée vide → « écrit
//     l'entrée de CETTE install » rougit.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { users } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let sessionUserId = '';
let home = '';

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ set: () => {}, get: () => null, delete: () => {} }),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('server-only', () => ({}));

vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({ userId: sessionUserId, entityId: seed?.entityId ?? '' }),
  };
});

// Le dossier personnel pointe dans un dossier temporaire : l'action ne touche
// jamais la vraie config de Claude Desktop de la machine qui lance les tests.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home };
});

const ARGV = [
  'C:\\Program Files\\nodejs\\node.exe',
  'C:\\Users\\q\\AppData\\Local\\npm-cache\\_npx\\a1\\node_modules\\nodal-agents\\dist\\index.js',
];

const saved = {
  argv: process.env['NODAL_CLI_ARGV'],
  appData: process.env['APPDATA'],
  xdg: process.env['XDG_CONFIG_HOME'],
};

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
  home = await mkdtemp(path.join(tmpdir(), 'nodal-485-action-'));
  process.env['APPDATA'] = path.join(home, 'AppData', 'Roaming');
  process.env['XDG_CONFIG_HOME'] = path.join(home, '.config');
});

afterEach(() => {
  restoreEnv('NODAL_CLI_ARGV', saved.argv);
});

afterAll(async () => {
  restoreEnv('APPDATA', saved.appData);
  restoreEnv('XDG_CONFIG_HOME', saved.xdg);
  await rm(home, { recursive: true, force: true });
});

describe('addNodalToClaudeDesktopAction @cap:connecter-un-service/moteur', () => {
  it('un non-propriétaire est refusé, et rien n’est écrit', async () => {
    const { addNodalToClaudeDesktopAction } = await import('../actions.ts');
    // Une session qui n'est pas celle du propriétaire, sans second compte en
    // base : c'est la garde propriétaire seule qui refuse.
    sessionUserId = '00000000-0000-4000-8000-000000000485';
    process.env['NODAL_CLI_ARGV'] = JSON.stringify(ARGV);

    const result = await addNodalToClaudeDesktopAction();
    expect(result).toMatchObject({ ok: false, code: 'forbidden' });
    const { claudeDesktopConfigPath } = await import('../mcp-clients.ts');
    const file = claudeDesktopConfigPath(process.platform, process.env, home, path.join);
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('sans NODAL_CLI_ARGV, l’action refuse au lieu d’inventer une commande', async () => {
    const { addNodalToClaudeDesktopAction } = await import('../actions.ts');
    sessionUserId = seed.userId;
    delete process.env['NODAL_CLI_ARGV'];

    const result = await addNodalToClaudeDesktopAction();
    expect(result).toMatchObject({ ok: false, code: 'cli_argv_missing' });
  });

  it('écrit l’entrée de CETTE install dans le fichier de Claude Desktop de la machine', async () => {
    const { addNodalToClaudeDesktopAction } = await import('../actions.ts');
    const { claudeDesktopConfigPath } = await import('../mcp-clients.ts');
    sessionUserId = seed.userId;
    process.env['NODAL_CLI_ARGV'] = JSON.stringify(ARGV);
    const file = claudeDesktopConfigPath(process.platform, process.env, home, path.join);
    await mkdir(path.dirname(file), { recursive: true });

    const result = await addNodalToClaudeDesktopAction();
    expect(result).toEqual({
      ok: true,
      data: { path: file, backupPath: null, replaced: false },
    });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      mcpServers: {
        nodal: { command: ARGV[0], args: [ARGV[1], 'mcp', 'serve'] },
      },
    });
  });

  it('une install à plusieurs comptes est refusée', async () => {
    const { addNodalToClaudeDesktopAction } = await import('../actions.ts');
    sessionUserId = seed.userId;
    process.env['NODAL_CLI_ARGV'] = JSON.stringify(ARGV);
    await testDb
      .insert(users)
      .values({ email: `second-user-${Date.now()}@example.com` })
      .returning();

    const result = await addNodalToClaudeDesktopAction();
    expect(result).toMatchObject({ ok: false, code: 'multi_user_host' });
  });
});

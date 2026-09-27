// autostart-actions.test.ts — le web APPELLE le CLI, il ne réécrit rien (#451).
//
// `getAutostartAction` et `setAutostartAction` lancent la commande qui a
// démarré la stack (`NODAL_CLI_ARGV`) avec `service <geste> --json`, et rendent
// ce qu'elle a répondu. Ici, un faux CLI : un script node qui écrit sur disque
// les arguments reçus et répond comme le vrai. Aucune tâche planifiée de la
// machine n'est touchée.
//
// Mutation vérifiée : `'--json'` retiré des arguments → « lit l'état » rougit
// (le faux CLI ne répond en JSON qu'avec lui, comme le vrai).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
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
vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: seed?.userId ?? 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

let dir = '';
let journal = '';

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
  dir = await mkdtemp(path.join(tmpdir(), 'nodal-451-'));
  journal = path.join(dir, 'calls.txt');
  const fake = path.join(dir, 'fake-cli.mjs');
  // Le faux CLI : il note ses arguments, et ne répond en JSON qu'avec --json.
  await writeFile(
    fake,
    `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(journal)}, args.join(' ') + '\\n');
process.stderr.write('(node) a warning on stderr\\n');
if (args.includes('--json')) {
  const state = args.includes('install') ? 'at_login' : 'off';
  process.stdout.write(JSON.stringify({ state }) + '\\n');
}
`,
    'utf8',
  );
  process.env['NODAL_CLI_ARGV'] = JSON.stringify([process.execPath, fake]);
});

afterAll(async () => {
  delete process.env['NODAL_CLI_ARGV'];
  await rm(dir, { recursive: true, force: true });
});

describe('le web appelle le CLI pour démarrer avec la machine (#451) @cap:installer-et-demarrer/moteur', () => {
  it('lit l’état en appelant `service status --json`', async () => {
    const { getAutostartAction } = await import('../actions.ts');
    const r = await getAutostartAction();
    if (!r.ok) throw new Error(`${r.code} ${r.message}`);
    expect(r.data).toEqual({ status: { state: 'off' }, error: null, isOwner: true });
    expect(await readFile(journal, 'utf8')).toContain('service status --json');
  });

  it('allumer appelle `service install --json`, et rend l’état que le CLI a relu', async () => {
    const { setAutostartAction } = await import('../actions.ts');
    const r = await setAutostartAction({ enabled: true });
    if (!r.ok) throw new Error(`${r.code} ${r.message}`);
    expect(r.data.status).toEqual({ state: 'at_login' });
    expect(await readFile(journal, 'utf8')).toContain('service install --json');
  });

  it('sans la commande du CLI, l’erreur est dite, jamais « off »', async () => {
    const saved = process.env['NODAL_CLI_ARGV'];
    delete process.env['NODAL_CLI_ARGV'];
    try {
      const { getAutostartAction } = await import('../actions.ts');
      const r = await getAutostartAction();
      if (!r.ok) throw new Error(`${r.code} ${r.message}`);
      expect(r.data.status).toBeNull();
      expect(r.data.error).toContain('nodal-agents up');
    } finally {
      process.env['NODAL_CLI_ARGV'] = saved;
    }
  });
});

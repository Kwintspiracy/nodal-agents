// cli-permissions-actions.test.ts — les réglages d'un agent à runtime CLI
// (mode, shell), relus en base après chaque action (#494).
//
// Revue Codex de #494, passe 4 : un shell réglé sur « auto » restait stocké
// quand l'agent repassait en lecture seule. L'interrupteur l'affichait éteint
// et verrouillé, donc personne ne pouvait l'effacer, et repasser en écriture
// (une confirmation qui ne parle que de fichiers) rallumait en silence un
// shell sans confinement. La lecture seule efface donc le réglage.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, eq } from '@nodal-agents/db';
import { cliShellPosture } from '@nodal-agents/shared';

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

const { setCliRuntimeModeAction, setCliRuntimeShellAction } = await import('../actions.ts');

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
});

async function stored() {
  const [r] = await testDb
    .select({ p: agents.cliPermissions })
    .from(agents)
    .where(eq(agents.id, seed.agentId));
  return r?.p ?? null;
}

describe('CLI runtime permissions, as stored @cap:executer-une-commande/ecran', () => {
  it('back to read only clears the shell: returning to write does not bring it back', async () => {
    await testDb
      .update(agents)
      .set({ cliPermissions: { mode: 'write', extraDisallowed: ['WebSearch'] } })
      .where(eq(agents.id, seed.agentId));
    expect((await setCliRuntimeShellAction({ agentId: seed.agentId, shell: 'auto' })).ok).toBe(
      true,
    );
    expect(await stored()).toEqual({
      mode: 'write',
      shell: 'auto',
      extraDisallowed: ['WebSearch'],
    });

    await setCliRuntimeModeAction({ agentId: seed.agentId, mode: 'read' });
    expect(await stored()).toEqual({ mode: 'read', shell: 'none', extraDisallowed: ['WebSearch'] });

    await setCliRuntimeModeAction({ agentId: seed.agentId, mode: 'write' });
    const back = await stored();
    expect(back).toEqual({ mode: 'write', shell: 'none', extraDisallowed: ['WebSearch'] });
    // Ce que le runner en fera : aucun shell tant que le propriétaire ne l'a
    // pas rallumé, avec sa propre confirmation.
    expect(cliShellPosture('claude', back, { autoRunPaused: false }).kind).toBe('no_shell');
  });

  // Revue Nodal de #551, passe 3 : l'action acceptait `shell: 'auto'` en
  // lecture seule, un réglage que le runner ignore (`cliShellPosture` : pas de
  // shell hors écriture). Stocké, il se rallumait en silence au passage en
  // écriture. La combinaison est refusée, et rien n'est écrit.
  it.each([
    ['read mode', { mode: 'read', shell: 'none' }],
    ['no setting at all (read by default)', null],
  ] as const)('shell auto is refused in %s, and nothing is stored', async (_label, perms) => {
    await testDb
      .update(agents)
      .set({ cliPermissions: perms as never })
      .where(eq(agents.id, seed.agentId));

    const res = await setCliRuntimeShellAction({ agentId: seed.agentId, shell: 'auto' });

    expect(res.ok).toBe(false);
    expect(await stored()).toEqual(perms);
    expect(cliShellPosture('claude', perms, { autoRunPaused: false }).kind).toBe('no_shell');
  });
});

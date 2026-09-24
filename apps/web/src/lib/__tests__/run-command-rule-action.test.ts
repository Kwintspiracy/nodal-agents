// run-command-rule-action.test.ts — la ligne « Run commands » de l'onglet
// Autonomy écrit les trois choix, et « aucune règle » (#468).
//
// Avant #468 c'était une bascule Yolo : allumée = `auto_approve`, éteinte =
// pas de règle. « Block » n'était posable depuis aucun écran. Ce fichier relit
// EN BASE, après chaque geste, la règle `run_command` de l'agent :
//   - chaque choix écrit SA règle, sans condition de dossier (`{}`, le
//     défaut de la colonne) ;
//   - `null` retire la règle (l'autonomie de l'espace décide) ;
//   - hors local-trust, seul le propriétaire écrit, dans les quatre sens ;
//   - « Run without asking » refuse d'écraser une règle confinée à un dossier
//     (elle deviendrait valable partout) ; Block et Ask la remplacent, ce
//     qui ne fait que resserrer.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and, approvalRules, entities, users } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let otherUserId: string;

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

// AUTH_MODE est figé au chargement d'`env.ts` : ce proxy le rend réglable à
// chaud, sans quoi le cas « tiers hors local-trust » ne serait pas testable
// (même levier que verify-commands-actions.test.ts).
const authState = vi.hoisted(() => ({ mode: 'local-trust' as 'local-trust' | 'local-auth' }));

vi.mock('../env.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env.ts')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, prop) => (prop === 'AUTH_MODE' ? authState.mode : Reflect.get(target, prop)),
    }),
  };
});

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

const FOLDER = 'D:/Dev/Excel';

beforeAll(async () => {
  testDb = (await spinUpTestDb()).db;
  seed = await seedMinimal(testDb);
  const [other] = await testDb
    .insert(users)
    .values({ email: `tiers-${Date.now()}@example.com` })
    .returning();
  otherUserId = other!.id;
});

beforeEach(async () => {
  authState.mode = 'local-trust';
  await testDb
    .delete(approvalRules)
    .where(and(eq(approvalRules.agentId, seed.agentId), eq(approvalRules.toolName, 'run_command')));
});

async function rule() {
  const rows = await testDb
    .select({ action: approvalRules.action, conditionJson: approvalRules.conditionJson })
    .from(approvalRules)
    .where(and(eq(approvalRules.agentId, seed.agentId), eq(approvalRules.toolName, 'run_command')));
  expect(rows.length, 'plus d’une règle run_command pour cet agent').toBeLessThanOrEqual(1);
  return rows[0] ?? null;
}

async function asNonOwner(run: () => Promise<void>) {
  await testDb.update(entities).set({ userId: otherUserId }).where(eq(entities.id, seed.entityId));
  try {
    await run();
  } finally {
    await testDb
      .update(entities)
      .set({ userId: seed.userId })
      .where(eq(entities.id, seed.entityId));
  }
}

async function folderRule() {
  await testDb.insert(approvalRules).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    toolName: 'run_command',
    action: 'auto_approve',
    conditionJson: { workspacePath: FOLDER },
  });
}

describe('setRunCommandRuleAction @cap:assigner-outils/moteur', () => {
  it('chaque choix écrit SA règle, et null la retire', async () => {
    const { setRunCommandRuleAction } = await import('../actions.ts');
    const agentId = seed.agentId;

    for (const action of ['block', 'require_approval', 'auto_approve'] as const) {
      const r = await setRunCommandRuleAction({ agentId, action });
      expect(r.ok, `${action} refusé`).toBe(true);
      expect(await rule()).toEqual({ action, conditionJson: {} });
    }

    expect((await setRunCommandRuleAction({ agentId, action: null })).ok).toBe(true);
    expect(await rule()).toBeNull();
  });

  it('hors local-trust, un tiers ne change rien, dans aucun des quatre sens', async () => {
    const { setRunCommandRuleAction } = await import('../actions.ts');
    await setRunCommandRuleAction({ agentId: seed.agentId, action: 'require_approval' });
    authState.mode = 'local-auth';

    await asNonOwner(async () => {
      for (const action of ['auto_approve', 'require_approval', 'block', null] as const) {
        const r = await setRunCommandRuleAction({ agentId: seed.agentId, action });
        expect(r.ok, `${String(action)} accepté pour un tiers`).toBe(false);
        if (!r.ok) expect(r.code).toBe('forbidden');
      }
    });
    expect(await rule()).toEqual({ action: 'require_approval', conditionJson: {} });

    // Le propriétaire, lui, écrit.
    expect((await setRunCommandRuleAction({ agentId: seed.agentId, action: 'block' })).ok).toBe(
      true,
    );
    expect(await rule()).toEqual({ action: 'block', conditionJson: {} });
  });

  it('« Run without asking » n’élargit pas une règle de dossier ; Block la remplace', async () => {
    const { setRunCommandRuleAction } = await import('../actions.ts');
    await folderRule();

    const partout = await setRunCommandRuleAction({
      agentId: seed.agentId,
      action: 'auto_approve',
    });
    expect(partout.ok).toBe(false);
    expect(await rule()).toEqual({
      action: 'auto_approve',
      conditionJson: { workspacePath: FOLDER },
    });

    expect((await setRunCommandRuleAction({ agentId: seed.agentId, action: 'block' })).ok).toBe(
      true,
    );
    expect(await rule()).toEqual({ action: 'block', conditionJson: {} });
  });

  it('refuse une action inconnue sans rien écrire', async () => {
    const { setRunCommandRuleAction } = await import('../actions.ts');
    const r = await setRunCommandRuleAction({ agentId: seed.agentId, action: 'allow' });
    expect(r.ok).toBe(false);
    expect(await rule()).toBeNull();
  });
});

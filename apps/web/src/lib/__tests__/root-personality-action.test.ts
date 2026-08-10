// root-personality-action.test.ts — la personnalité de l'agent racine.
//
// C'est du texte injecté dans le prompt système de l'agent qui orchestre tous
// les autres. Une écriture qui rate silencieusement ne casse rien de visible :
// l'interface affiche « enregistré », et l'agent continue avec l'ancienne
// consigne. C'est le motif exact du bug qui a motivé ce lot de tests
// (`setAgentApprovalRuleAction` répondait `ok` sans écrire).
//
// D'où le parti pris : aucun test ne se contente de `result.ok`. Chacun relit la
// colonne `agents.personality`.
//
// L'action désigne sa cible en deux temps — `entities.rootAgentId` donne l'id,
// puis l'UPDATE le recroise avec l'entité de la session. Ce double filtre a une
// conséquence qu'il fallait figer : si le pointeur `rootAgentId` désigne un
// agent d'un autre espace, l'UPDATE ne touche aucune ligne et l'action répond
// quand même `ok`. Le dernier test l'établit — la garde protège bien le voisin,
// mais le succès annoncé est faux.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agents, entities, users } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** L'agent racine légitime de l'espace de la session. */
let racineId = '';
/** Un agent racine appartenant à un autre espace. */
let racineVoisine = '';

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

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  const [racine] = await testDb
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Racine',
      slug: `racine-${Date.now()}`,
      personality: 'Consigne d’origine.',
    })
    .returning();
  racineId = racine!.id;

  const [autreUser] = await testDb
    .insert(users)
    .values({ email: `voisin-root-${Date.now()}@example.com` })
    .returning();
  const [autreEntite] = await testDb
    .insert(entities)
    .values({
      userId: autreUser!.id,
      name: 'Espace voisin',
      slug: `voisin-root-${Date.now()}`,
    })
    .returning();
  const [racineDuVoisin] = await testDb
    .insert(agents)
    .values({
      entityId: autreEntite!.id,
      name: 'Racine du voisin',
      slug: `racine-voisin-${Date.now()}`,
      personality: 'Consigne du voisin.',
    })
    .returning();
  racineVoisine = racineDuVoisin!.id;
});

/** Désigne (ou retire) l'agent racine de l'espace de la session. */
async function designerRacine(agentId: string | null) {
  await testDb.update(entities).set({ rootAgentId: agentId }).where(eq(entities.id, seed.entityId));
}

async function personnaliteDe(agentId: string): Promise<string | null> {
  const [row] = await testDb
    .select({ personality: agents.personality })
    .from(agents)
    .where(eq(agents.id, agentId));
  return row?.personality ?? null;
}

afterEach(async () => {
  await designerRacine(racineId);
  await testDb
    .update(agents)
    .set({ personality: 'Consigne d’origine.' })
    .where(eq(agents.id, racineId));
});

describe('updateRootPersonalityAction', () => {
  it('écrit la personnalité sur l’agent racine désigné', async () => {
    const { updateRootPersonalityAction } = await import('../actions.ts');
    await designerRacine(racineId);

    const result = await updateRootPersonalityAction({
      personality: 'Tu réponds court, et tu cites tes sources.',
    });

    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    expect(await personnaliteDe(racineId)).toBe('Tu réponds court, et tu cites tes sources.');
  });

  it('refuse quand aucun agent racine n’est désigné — et n’écrit nulle part', async () => {
    const { updateRootPersonalityAction } = await import('../actions.ts');
    await designerRacine(null);

    const result = await updateRootPersonalityAction({ personality: 'Dans le vide.' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
    expect(await personnaliteDe(racineId)).toBe('Consigne d’origine.');
    expect(await personnaliteDe(seed.agentId), 'l’écriture a dérivé sur un autre agent').toBe(
      'You are a test agent.',
    );
  });

  it('n’écrase pas les autres agents de l’espace', async () => {
    const { updateRootPersonalityAction } = await import('../actions.ts');
    await designerRacine(racineId);

    await updateRootPersonalityAction({ personality: 'Réservé à la racine.' });

    expect(await personnaliteDe(seed.agentId), 'un agent ordinaire a reçu la consigne racine').toBe(
      'You are a test agent.',
    );
  });

  it('refuse une personnalité vide, et laisse la précédente en place', async () => {
    const { updateRootPersonalityAction } = await import('../actions.ts');
    await designerRacine(racineId);

    const result = await updateRootPersonalityAction({ personality: '' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('validation_failed');
    expect(await personnaliteDe(racineId)).toBe('Consigne d’origine.');
  });

  it('refuse au-delà de 20 000 caractères, accepte la borne exacte', async () => {
    const { updateRootPersonalityAction } = await import('../actions.ts');
    await designerRacine(racineId);

    const auPlafond = 'a'.repeat(20_000);
    const trop = 'a'.repeat(20_001);

    const refuse = await updateRootPersonalityAction({ personality: trop });
    expect(refuse.ok).toBe(false);
    expect(await personnaliteDe(racineId)).toBe('Consigne d’origine.');

    const accepte = await updateRootPersonalityAction({ personality: auPlafond });
    expect(accepte.ok, accepte.ok ? '' : accepte.message).toBe(true);
    expect((await personnaliteDe(racineId))?.length).toBe(20_000);
  });

  it('refuse un corps qui n’a pas la bonne forme', async () => {
    const { updateRootPersonalityAction } = await import('../actions.ts');
    await designerRacine(racineId);

    const result = await updateRootPersonalityAction({ prompt: 'mauvaise clé' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('validation_failed');
    expect(await personnaliteDe(racineId)).toBe('Consigne d’origine.');
  });

  it('un pointeur racine qui désigne l’agent d’un autre espace n’écrit RIEN chez lui', async () => {
    const { updateRootPersonalityAction } = await import('../actions.ts');
    // État corrompu volontaire : le pointeur traverse la frontière d'espace.
    await designerRacine(racineVoisine);

    const result = await updateRootPersonalityAction({ personality: 'Consigne injectée.' });

    // La garde tient : rien n'est écrit chez le voisin.
    expect(await personnaliteDe(racineVoisine), 'la racine du voisin a été réécrite').toBe(
      'Consigne du voisin.',
    );
    // Le succès annoncé est en revanche mensonger — c'est le contrat actuel,
    // figé ici pour qu'un durcissement futur soit un changement VISIBLE.
    expect(result.ok).toBe(true);
  });
});

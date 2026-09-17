// agent-model-effort-action.test.ts — régler le modèle et l'effort d'un agent
// depuis le composeur (#138).
//
// L'action est courte, et ses DEUX refus sont ce qui la rend sûre :
//   • un effort que le contrôle du modèle n'offre pas. Sans ce refus, un agent
//     part avec un réglage que le fournisseur ignore, et personne ne le voit :
//     l'écran affiche « Max », les appels n'en portent rien.
//   • un modèle qui n'est pas au catalogue du fournisseur de la clé. La
//     pastille n'en propose pas d'autres, mais une requête forgée en propose
//     ce qu'elle veut — et un agent posé sur un modèle qui n'existe pas
//     n'échoue qu'au premier message, loin d'ici.
// L'exception à ce second refus est délibérée : le modèle DÉJÀ écrit passe
// toujours, sinon un agent posé sur un identifiant libre depuis l'écran
// d'édition ne pourrait plus changer d'effort sans perdre son modèle.
//
// Les assertions portent sur la LIGNE en base après coup (invariant #5).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, entities, entityLlmKeys, users, eq } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
/** Un agent branché sur une clé OpenAI — gpt-5 est au catalogue. */
let openaiAgentId = '';
let voisinAgentId = '';

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

  const [openaiKey] = await testDb
    .insert(entityLlmKeys)
    .values({ entityId: seed.entityId, provider: 'openai', apiKey: '', nickname: 'OpenAI' })
    .returning();
  const [agent] = await testDb
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Composer Agent',
      slug: `composer-agent-${Date.now()}`,
      personality: 'Test.',
      llmKeyId: openaiKey!.id,
      model: 'gpt-5',
      reasoningEffort: 'medium',
    })
    .returning();
  openaiAgentId = agent!.id;

  // Un agent d'un AUTRE espace : la garde de portée se prouve sur une vraie
  // ligne, pas sur un identifiant inventé (qui serait « introuvable » pour la
  // mauvaise raison).
  const [autreUser] = await testDb
    .insert(users)
    .values({ email: `voisin-model-${Date.now()}@example.com` })
    .returning();
  const [autreEntite] = await testDb
    .insert(entities)
    .values({
      userId: autreUser!.id,
      name: 'Espace voisin',
      slug: `voisin-model-${Date.now()}`,
    })
    .returning();
  const [voisin] = await testDb
    .insert(agents)
    .values({
      entityId: autreEntite!.id,
      name: 'Voisin',
      slug: `voisin-agent-${Date.now()}`,
      personality: 'Test.',
      model: 'gpt-5',
    })
    .returning();
  voisinAgentId = voisin!.id;
});

async function ligne(
  id: string,
): Promise<{ model: string | null; reasoningEffort: string | null }> {
  const [row] = await testDb
    .select({ model: agents.model, reasoningEffort: agents.reasoningEffort })
    .from(agents)
    .where(eq(agents.id, id));
  return row!;
}

describe('setAgentModelAndEffortAction @cap:choisir-modele/moteur', () => {
  it('écrit le modèle et l’effort quand le catalogue les offre', async () => {
    const { setAgentModelAndEffortAction } = await import('../actions.ts');
    const r = await setAgentModelAndEffortAction({
      agentId: openaiAgentId,
      model: 'gpt-5-mini',
      reasoningEffort: 'high',
    });
    expect(r.ok).toBe(true);
    expect(await ligne(openaiAgentId)).toEqual({ model: 'gpt-5-mini', reasoningEffort: 'high' });
  });

  it('« Auto » s’écrit comme un NULL, pas comme une chaîne', async () => {
    const { setAgentModelAndEffortAction } = await import('../actions.ts');
    const r = await setAgentModelAndEffortAction({
      agentId: openaiAgentId,
      model: 'gpt-5',
      reasoningEffort: null,
    });
    expect(r.ok).toBe(true);
    expect(await ligne(openaiAgentId)).toEqual({ model: 'gpt-5', reasoningEffort: null });
  });

  it('REFUSE un effort que le modèle n’offre pas, et ne touche à rien', async () => {
    const { setAgentModelAndEffortAction } = await import('../actions.ts');
    const avant = await ligne(openaiAgentId);
    // gpt-5 déclare low / medium / high, et son raisonnement est obligatoire :
    // ni 'max' ni 'off' n'existent pour lui.
    const r = await setAgentModelAndEffortAction({
      agentId: openaiAgentId,
      model: 'gpt-5',
      reasoningEffort: 'max',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('max');
    expect(await ligne(openaiAgentId)).toEqual(avant);
  });

  it('REFUSE un modèle hors du catalogue du fournisseur, et ne touche à rien', async () => {
    const { setAgentModelAndEffortAction } = await import('../actions.ts');
    const avant = await ligne(openaiAgentId);
    const r = await setAgentModelAndEffortAction({
      agentId: openaiAgentId,
      model: 'claude-opus-5',
      reasoningEffort: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('claude-opus-5');
    expect(await ligne(openaiAgentId)).toEqual(avant);
  });

  it('accepte de RÉÉCRIRE le modèle déjà posé, même hors catalogue', async () => {
    const { setAgentModelAndEffortAction } = await import('../actions.ts');
    // Un identifiant libre, comme l'écran d'édition en autorise depuis une
    // liste en direct.
    await testDb
      .update(agents)
      .set({ model: 'un-modele-maison', reasoningEffort: null })
      .where(eq(agents.id, openaiAgentId));
    const r = await setAgentModelAndEffortAction({
      agentId: openaiAgentId,
      model: 'un-modele-maison',
      reasoningEffort: null,
    });
    expect(r.ok).toBe(true);
    expect(await ligne(openaiAgentId)).toEqual({
      model: 'un-modele-maison',
      reasoningEffort: null,
    });
    // ... mais pas un effort de plus : hors catalogue, aucun palier n'existe.
    const refus = await setAgentModelAndEffortAction({
      agentId: openaiAgentId,
      model: 'un-modele-maison',
      reasoningEffort: 'high',
    });
    expect(refus.ok).toBe(false);
    await testDb.update(agents).set({ model: 'gpt-5' }).where(eq(agents.id, openaiAgentId));
  });

  it('l’agent d’un AUTRE espace est introuvable, et reste intact', async () => {
    const { setAgentModelAndEffortAction } = await import('../actions.ts');
    const r = await setAgentModelAndEffortAction({
      agentId: voisinAgentId,
      model: 'gpt-5-mini',
      reasoningEffort: 'low',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
    expect(await ligne(voisinAgentId)).toEqual({ model: 'gpt-5', reasoningEffort: null });
  });
});

describe('getAgentModelChoicesAction @cap:choisir-modele/moteur', () => {
  it('rend le modèle courant, ses paliers, et le catalogue du fournisseur', async () => {
    const { getAgentModelChoicesAction } = await import('../actions.ts');
    const r = await getAgentModelChoicesAction(openaiAgentId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.model).toBe('gpt-5');
    expect(r.data.modelOptions.map((o) => o.modelId)).toContain('gpt-5-mini');
    // Les paliers sont ceux du catalogue, par modèle — c'est ce qui permet à la
    // pastille de laisser tomber un effort que le nouveau modèle n'offre pas.
    expect(r.data.effortsByModel['gpt-5']).toEqual(['low', 'medium', 'high']);
    // Aucun modèle d'un autre fournisseur ne s'y glisse.
    expect(r.data.modelOptions.map((o) => o.modelId)).not.toContain('claude-opus-5');
  });

  it('l’agent d’un autre espace est introuvable', async () => {
    const { getAgentModelChoicesAction } = await import('../actions.ts');
    const r = await getAgentModelChoicesAction(voisinAgentId);
    expect(r.ok).toBe(false);
  });
});

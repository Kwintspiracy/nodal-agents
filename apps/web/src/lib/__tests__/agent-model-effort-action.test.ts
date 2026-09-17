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
let openaiKeyId = '';
let anthropicKeyId = '';
/** Une clé de l'espace, mais ÉTEINTE : l'écran d'édition ne l'offre pas. */
let cleEteinteId = '';
/** Un routeur : il délègue par appel d'outil, son modèle doit en avoir. */
let routeurId = '';
let voisinAgentId = '';
let voisinKeyId = '';

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
  openaiKeyId = openaiKey!.id;
  const [anthropicKey] = await testDb
    .insert(entityLlmKeys)
    .values({ entityId: seed.entityId, provider: 'anthropic', apiKey: '', nickname: 'Anthropic' })
    .returning();
  anthropicKeyId = anthropicKey!.id;
  const [cleEteinte] = await testDb
    .insert(entityLlmKeys)
    .values({
      entityId: seed.entityId,
      provider: 'openai',
      apiKey: '',
      nickname: 'Old key',
      isActive: false,
    })
    .returning();
  cleEteinteId = cleEteinte!.id;
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

  const [routeur] = await testDb
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Composer Router',
      slug: `composer-router-${Date.now()}`,
      personality: 'Test.',
      role: 'orchestrator',
      orchestratorMode: 'router',
      llmKeyId: openaiKey!.id,
      model: 'gpt-5',
    })
    .returning();
  routeurId = routeur!.id;

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
  const [voisinKey] = await testDb
    .insert(entityLlmKeys)
    .values({ entityId: autreEntite!.id, provider: 'openai', apiKey: '', nickname: 'Voisin' })
    .returning();
  voisinKeyId = voisinKey!.id;
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

async function ligne(id: string): Promise<{
  model: string | null;
  reasoningEffort: string | null;
  llmKeyId: string | null;
}> {
  const [row] = await testDb
    .select({
      model: agents.model,
      reasoningEffort: agents.reasoningEffort,
      llmKeyId: agents.llmKeyId,
    })
    .from(agents)
    .where(eq(agents.id, id));
  return row!;
}

describe('setAgentModelAndEffortAction @cap:choisir-modele/moteur', () => {
  it('écrit le modèle et l’effort que le modèle offre', async () => {
    const { setAgentModelAndEffortAction } = await import('../actions.ts');
    const r = await setAgentModelAndEffortAction({
      agentId: openaiAgentId,
      model: 'gpt-5-mini',
      reasoningEffort: 'high',
    });
    expect(r.ok).toBe(true);
    expect(await ligne(openaiAgentId)).toEqual({
      model: 'gpt-5-mini',
      reasoningEffort: 'high',
      llmKeyId: openaiKeyId,
    });
  });

  it('« Auto » s’écrit comme un NULL, pas comme une chaîne', async () => {
    const { setAgentModelAndEffortAction } = await import('../actions.ts');
    const r = await setAgentModelAndEffortAction({
      agentId: openaiAgentId,
      model: 'gpt-5',
      reasoningEffort: null,
    });
    expect(r.ok).toBe(true);
    expect((await ligne(openaiAgentId)).reasoningEffort).toBeNull();
  });

  it('REFUSE un effort que le modèle catalogué n’offre pas, et ne touche à rien', async () => {
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

  it('change la CLÉ, et repose le modèle qu’on lui donne', async () => {
    const { setAgentModelAndEffortAction } = await import('../actions.ts');
    const r = await setAgentModelAndEffortAction({
      agentId: openaiAgentId,
      llmKeyId: anthropicKeyId,
      model: 'claude-opus-5',
      reasoningEffort: 'max',
    });
    expect(r.ok).toBe(true);
    expect(await ligne(openaiAgentId)).toEqual({
      model: 'claude-opus-5',
      reasoningEffort: 'max',
      llmKeyId: anthropicKeyId,
    });
    // L'effort se juge sur le catalogue de la NOUVELLE clé : 'max' n'existe pas
    // chez OpenAI et vient pourtant d'être accepté.
    await setAgentModelAndEffortAction({
      agentId: openaiAgentId,
      llmKeyId: openaiKeyId,
      model: 'gpt-5',
      reasoningEffort: 'high',
    });
  });

  it('la clé primaire ne reste pas dans la chaîne de repli', async () => {
    const { setAgentModelAndEffortAction } = await import('../actions.ts');
    await testDb
      .update(agents)
      .set({
        llmKeyId: openaiKeyId,
        fallbackChain: [
          { keyId: anthropicKeyId, model: 'claude-opus-5' },
          { keyId: openaiKeyId, model: 'gpt-5' },
        ],
      })
      .where(eq(agents.id, openaiAgentId));
    const r = await setAgentModelAndEffortAction({
      agentId: openaiAgentId,
      llmKeyId: anthropicKeyId,
      model: 'claude-opus-5',
      reasoningEffort: null,
    });
    expect(r.ok).toBe(true);
    const [row] = await testDb
      .select({ fallbackChain: agents.fallbackChain })
      .from(agents)
      .where(eq(agents.id, openaiAgentId));
    // Un agent qui se replie sur lui-même n'est pas un repli.
    expect(row!.fallbackChain?.map((l) => l.keyId)).toEqual([openaiKeyId]);
    await testDb
      .update(agents)
      .set({ llmKeyId: openaiKeyId, model: 'gpt-5', fallbackChain: [] })
      .where(eq(agents.id, openaiAgentId));
  });

  it('REFUSE une clé d’un autre espace, et ne touche à rien', async () => {
    const { setAgentModelAndEffortAction } = await import('../actions.ts');
    const avant = await ligne(openaiAgentId);
    const r = await setAgentModelAndEffortAction({
      agentId: openaiAgentId,
      llmKeyId: voisinKeyId,
      model: 'gpt-5',
      reasoningEffort: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
    expect(await ligne(openaiAgentId)).toEqual(avant);
  });

  it('REFUSE une clé désactivée, et ne touche à rien', async () => {
    const { setAgentModelAndEffortAction } = await import('../actions.ts');
    const avant = await ligne(openaiAgentId);
    const r = await setAgentModelAndEffortAction({
      agentId: openaiAgentId,
      llmKeyId: cleEteinteId,
      model: 'gpt-5',
      reasoningEffort: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('disabled');
    expect(await ligne(openaiAgentId)).toEqual(avant);
  });

  it('ACCEPTE un modèle hors catalogue — les réglages l’acceptent aussi', async () => {
    const { setAgentModelAndEffortAction } = await import('../actions.ts');
    // Un identifiant vu en direct chez le fournisseur, ou saisi à la main sur
    // l'écran d'édition : refuser ici interdirait ce que les réglages offrent.
    const r = await setAgentModelAndEffortAction({
      agentId: openaiAgentId,
      model: 'gpt-6-preview-not-catalogued',
      reasoningEffort: null,
    });
    expect(r.ok).toBe(true);
    expect((await ligne(openaiAgentId)).model).toBe('gpt-6-preview-not-catalogued');
    // Et son effort passe aussi : hors catalogue, rien ne dit qu'il ne l'offre
    // pas, et inventer un refus sur une absence serait un faux « non ».
    const avecEffort = await setAgentModelAndEffortAction({
      agentId: openaiAgentId,
      model: 'gpt-6-preview-not-catalogued',
      reasoningEffort: 'high',
    });
    expect(avecEffort.ok).toBe(true);
    expect((await ligne(openaiAgentId)).reasoningEffort).toBe('high');
    await testDb
      .update(agents)
      .set({ model: 'gpt-5', reasoningEffort: 'high' })
      .where(eq(agents.id, openaiAgentId));
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
    expect((await ligne(voisinAgentId)).model).toBe('gpt-5');
  });
});

describe('getAgentModelChoicesAction @cap:choisir-modele/moteur', () => {
  it('dit si l’agent EXIGE des outils : un routeur oui, un agent non', async () => {
    const { getAgentModelChoicesAction } = await import('../actions.ts');
    const agent = await getAgentModelChoicesAction(openaiAgentId);
    const routeur = await getAgentModelChoicesAction(routeurId);
    expect(agent.ok && agent.data.requireTools).toBe(false);
    expect(routeur.ok && routeur.data.requireTools).toBe(true);
  });

  it('un routeur garde un modèle catalogué AVEC outils : la garde ne refuse pas à tort', async () => {
    // La branche qui REFUSE (modèle catalogué sans outils) n'est atteignable
    // par aucune ligne du vrai catalogue aujourd'hui : elle se prouve sur la
    // règle pure (`disabledHintFor`), pas ici. Ce cas prouve l'autre moitié :
    // la garde passe pour un routeur quand le modèle a des outils.
    const { setAgentModelAndEffortAction } = await import('../actions.ts');
    const r = await setAgentModelAndEffortAction({
      agentId: routeurId,
      model: 'gpt-5-mini',
      reasoningEffort: null,
    });
    expect(r.ok).toBe(true);
    expect((await ligne(routeurId)).model).toBe('gpt-5-mini');
  });

  it('rend la clé de l’agent, son modèle, son effort et les clés ACTIVES', async () => {
    const { getAgentModelChoicesAction } = await import('../actions.ts');
    const r = await getAgentModelChoicesAction(openaiAgentId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.model).toBe('gpt-5');
    expect(r.data.llmKeyId).toBe(openaiKeyId);
    const ids = r.data.llmKeys.map((k) => k.id);
    expect(ids).toContain(openaiKeyId);
    expect(ids).toContain(anthropicKeyId);
    // Une clé éteinte ne se propose pas : l'écran d'édition non plus ne
    // l'offre pas.
    expect(ids).not.toContain(cleEteinteId);
    // Et aucune clé du voisin ne s'y glisse.
    expect(ids).not.toContain(voisinKeyId);
  });

  it('l’agent d’un autre espace est introuvable', async () => {
    const { getAgentModelChoicesAction } = await import('../actions.ts');
    const r = await getAgentModelChoicesAction(voisinAgentId);
    expect(r.ok).toBe(false);
  });
});

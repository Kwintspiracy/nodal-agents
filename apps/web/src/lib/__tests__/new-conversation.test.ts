// new-conversation.test.ts — le MOTEUR de #248, sur une vraie base.
//
// Deux faits, et ils sont indissociables :
//
//   1. OUVRIR l'écran de conversation neuve n'écrit RIEN. C'est le bug que
//      #248 ferme : « New conversation » créait la ligne d'abord, et un
//      dossier ouvert sans un mot laissait un fil vide pour toujours.
//   2. Le PREMIER ENVOI, lui, écrit — la conversation naît, attribuée au ROOT,
//      et le message part vers ELLE. Les deux moitiés du geste sont ici :
//      la ligne relue en base, et le corps de la requête faite au runner.
//   3. Et un premier envoi RATÉ ne laisse rien. Créer puis envoyer fait deux
//      appels ; entre les deux, le runner peut être coupé. Sans le ménage, la
//      ligne vide restait, et l'orphelin de #248 changeait simplement de porte
//      (revue Reviewer C, passe 1). Le ménage ne touche QUE le vide : un envoi
//      qui échoue après l'ouverture du flux a déjà son message en base.
//
// Les comptes sont relus en base avant et après, jamais déduits d'un `ok`.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  agents,
  agentJobs,
  chatMessages,
  conversations,
  entities,
  users,
} from '@nodal-agents/db';

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
    requireAuth: async () => ({ userId: seed.userId, entityId: seed.entityId }),
  };
});

// Le runner n'est pas là : on lui répond nous-même, et on GARDE le corps de la
// requête — c'est lui qui dit à quelle conversation le message est parti.
vi.mock('@/lib/env.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env.ts')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (t, k) =>
        k === 'WORKER_SECRET'
          ? 'secret-de-test'
          : k === 'RUNNER_URL'
            ? 'http://127.0.0.1:3001'
            : Reflect.get(t, k),
    }),
  };
});

/** Combien de conversations l'espace porte, relues en base. */
async function compteFils(): Promise<number> {
  const rows = await testDb
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.entityId, seed.entityId));
  return rows.length;
}

async function designeLeRoot(agentId: string | null): Promise<void> {
  await testDb.update(entities).set({ rootAgentId: agentId }).where(eq(entities.id, seed.entityId));
}

beforeAll(async () => {
  testDb = (await spinUpTestDb()).db;
  seed = await seedMinimal(testDb);
});

beforeEach(async () => {
  await testDb.delete(conversations).where(eq(conversations.entityId, seed.entityId));
  await designeLeRoot(null);
  await testDb.update(users).set({ name: '' }).where(eq(users.id, seed.userId));
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('getNewConversationAction @cap:parler-a-un-agent/moteur', () => {
  it('ouvrir l’écran n’écrit AUCUNE ligne — avant zéro, après zéro', async () => {
    const { getNewConversationAction } = await import('../conversation-actions.ts');
    await designeLeRoot(seed.agentId);

    expect(await compteFils()).toBe(0);
    const r = await getNewConversationAction();
    expect(r.ok).toBe(true);
    // LE fait de #248 : l'écran s'est ouvert, la base n'a pas bougé.
    expect(await compteFils()).toBe(0);
  });

  it('rend le ROOT — celui qui recevra la conversation, avec son visage', async () => {
    const { getNewConversationAction } = await import('../conversation-actions.ts');
    await testDb
      .update(agents)
      .set({ name: 'Alfred', avatarUrl: 'https://exemple.test/alfred.png' })
      .where(eq(agents.id, seed.agentId));
    await designeLeRoot(seed.agentId);

    const r = await getNewConversationAction();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.root).toEqual({
      id: seed.agentId,
      name: 'Alfred',
      avatarUrl: 'https://exemple.test/alfred.png',
    });
  });

  it('sans ROOT désigné, elle le DIT — elle n’en choisit pas un à la place', async () => {
    const { getNewConversationAction } = await import('../conversation-actions.ts');
    const r = await getNewConversationAction();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.root).toBeNull();
  });

  it('le nom vient du compte, et reste `null` quand le compte n’en porte pas', async () => {
    const { getNewConversationAction } = await import('../conversation-actions.ts');
    await designeLeRoot(seed.agentId);

    const vide = await getNewConversationAction();
    expect(vide.ok && vide.data.accountName).toBeNull();

    await testDb.update(users).set({ name: 'Quentin Beau' }).where(eq(users.id, seed.userId));
    const nomme = await getNewConversationAction();
    expect(nomme.ok && nomme.data.accountName).toBe('Quentin Beau');
  });

  it('un projet inconnu échoue — l’écran ne s’ouvre pas sans son ancrage', async () => {
    const { getNewConversationAction } = await import('../conversation-actions.ts');
    await designeLeRoot(seed.agentId);
    const r = await getNewConversationAction('00000000-0000-0000-0000-0000000000ff');
    expect(r).toEqual({ ok: false, code: 'not_found', message: 'Project not found' });
    expect(await compteFils()).toBe(0);
  });
});

describe('le premier envoi @cap:parler-a-un-agent/moteur', () => {
  it('crée la conversation ET lui adresse le message, dans le même geste', async () => {
    const { createConversationAction, sendChatMessageAction } = await import('../actions.ts');
    await designeLeRoot(seed.agentId);

    // AVANT : rien. C'est l'écran vide, personne n'a encore parlé.
    expect(await compteFils()).toBe(0);

    // Le geste, moitié 1 — ce que la saisie fait avant d'envoyer.
    const creation = await createConversationAction();
    expect(creation.ok).toBe(true);
    if (!creation.ok) return;

    // APRÈS : une ligne, et une seule. Relue, pas déduite.
    expect(await compteFils()).toBe(1);
    const [ligne] = await testDb
      .select()
      .from(conversations)
      .where(eq(conversations.id, creation.data.id));
    expect(ligne).toBeDefined();
    // Elle est attribuée au ROOT, sans titre, et c'est une conversation de la
    // personne — pas un entretien d'accueil.
    expect(ligne!.agentId).toBe(seed.agentId);
    expect(ligne!.title).toBe('');
    expect(ligne!.origin).toBe('user');

    // Le geste, moitié 2 — le message part vers CETTE conversation. On lit le
    // corps réel de la requête faite au runner, jamais un compteur d'appels.
    let corps: unknown = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        corps = JSON.parse(init.body);
        return new Response(JSON.stringify({ reply: 'Bien reçu.' }), { status: 200 });
      }),
    );
    const envoi = await sendChatMessageAction({
      conversationId: creation.data.id,
      message: 'Range le dossier',
    });
    expect(envoi.ok).toBe(true);
    expect(corps).toEqual({
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: creation.data.id,
      message: 'Range le dossier',
    });

    // Et le geste n'a pas fabriqué de seconde ligne au passage.
    expect(await compteFils()).toBe(1);
  });

  it('un envoi RATÉ ne laisse aucune ligne : la table relue est vide', async () => {
    const { createConversationAction, sendChatMessageAction, discardEmptyConversationAction } =
      await import('../actions.ts');
    await designeLeRoot(seed.agentId);

    const creation = await createConversationAction();
    expect(creation.ok).toBe(true);
    if (!creation.ok) return;
    expect(await compteFils()).toBe(1);

    // Le runner est coupé : le flux ne s'ouvre pas, rien n'est écrit.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const envoi = await sendChatMessageAction({
      conversationId: creation.data.id,
      message: 'Range le dossier',
    });
    expect(envoi.ok).toBe(false);

    // Le chemin d'échec de la saisie, celui que `onSendFailed` appelle.
    const jet = await discardEmptyConversationAction(creation.data.id);
    expect(jet).toEqual({ ok: true, data: { discarded: true } });

    // LA preuve : la table, relue. Pas un `ok`, pas un compteur d'appels.
    expect(await compteFils()).toBe(0);
    const restes = await testDb
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, creation.data.id));
    expect(restes).toEqual([]);
  });

  it('mais un fil qui porte DÉJÀ le message n’est pas jeté — on ne perd pas ce qui est écrit', async () => {
    const { createConversationAction, discardEmptyConversationAction } =
      await import('../actions.ts');
    await designeLeRoot(seed.agentId);

    const creation = await createConversationAction();
    expect(creation.ok).toBe(true);
    if (!creation.ok) return;

    // Le runner écrit le tour de la personne AVANT d'appeler le modèle : un
    // échec passé l'ouverture du flux laisse donc CE message-là.
    await testDb.insert(chatMessages).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: creation.data.id,
      role: 'user',
      content: 'Range le dossier',
    });

    const jet = await discardEmptyConversationAction(creation.data.id);
    expect(jet).toEqual({ ok: true, data: { discarded: false } });
    expect(await compteFils()).toBe(1);
  });

  it('un fil qui porte un TRAVAIL n’est pas jeté non plus', async () => {
    const { createConversationAction, discardEmptyConversationAction } =
      await import('../actions.ts');
    await designeLeRoot(seed.agentId);

    const creation = await createConversationAction();
    expect(creation.ok).toBe(true);
    if (!creation.ok) return;

    await testDb.insert(agentJobs).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: creation.data.id,
      channel: 'dashboard',
      task: 'Range le dossier',
    });

    const jet = await discardEmptyConversationAction(creation.data.id);
    expect(jet).toEqual({ ok: true, data: { discarded: false } });
    expect(await compteFils()).toBe(1);
  });

  it('le jet ne sort pas de l’espace de travail : le fil du voisin reste', async () => {
    const { discardEmptyConversationAction } = await import('../actions.ts');

    const [voisinUser] = await testDb
      .insert(users)
      .values({ email: `voisin-newconv-${Date.now()}@example.com` })
      .returning();
    const [voisinEntite] = await testDb
      .insert(entities)
      .values({
        userId: voisinUser!.id,
        name: 'Espace voisin',
        slug: `voisin-newconv-${Date.now()}`,
      })
      .returning();
    const [voisinAgent] = await testDb
      .insert(agents)
      .values({
        entityId: voisinEntite!.id,
        name: 'Agent du voisin',
        slug: `agent-voisin-newconv-${Date.now()}`,
        personality: 'Pas le vôtre.',
      })
      .returning();
    const [filVoisin] = await testDb
      .insert(conversations)
      .values({
        entityId: voisinEntite!.id,
        agentId: voisinAgent!.id,
        title: '',
        origin: 'user',
      })
      .returning({ id: conversations.id });

    // Vide, donc « jetable » — et pourtant il ne bouge pas : l'entité tranche.
    const jet = await discardEmptyConversationAction(filVoisin!.id);
    expect(jet).toEqual({ ok: true, data: { discarded: false } });
    const restes = await testDb
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, filVoisin!.id));
    expect(restes).toHaveLength(1);
  });

  it('sans ROOT, rien ne naît — le refus est dit, la base reste vide', async () => {
    const { createConversationAction } = await import('../actions.ts');
    const r = await createConversationAction();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('no_root_agent');
    expect(await compteFils()).toBe(0);
  });
});

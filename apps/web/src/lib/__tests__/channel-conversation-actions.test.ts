// channel-conversation-actions.test.ts — lot 1, l'action qui OUVRE un canal.
//
// `resolveChannelAllowedConversationAction` est le point où un inconnu qui a
// écrit au bot devient un interlocuteur autorisé. Approuver, c'est donner à
// quelqu'un le droit de faire travailler un agent — avec ses connecteurs, ses
// clés et son budget.
//
// Deux façons de mal tourner :
//
//   - approuver une conversation qui n'était pas en attente (rejouer une
//     décision déjà prise, ou ressusciter une ligne révoquée) ;
//   - approuver la ligne d'un AUTRE espace, dont on ne connaît que le GUID.
//
// Les assertions relisent donc `status` en base, et vérifient que « refuser »
// supprime réellement la ligne au lieu de la laisser en attente pour toujours.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  and,
  agents,
  channelAllowedConversations,
  entities,
  entityMembers,
  users,
} from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let foreignEntityId: string;
let foreignAgentId: string;

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

  const existing = await testDb
    .select()
    .from(entityMembers)
    .where(and(eq(entityMembers.entityId, seed.entityId), eq(entityMembers.userId, seed.userId)));
  if (existing.length === 0) {
    await testDb
      .insert(entityMembers)
      .values({ entityId: seed.entityId, userId: seed.userId, role: 'owner' });
  }

  const [otherUser] = await testDb
    .insert(users)
    .values({ email: `voisin-${Date.now()}@example.com` })
    .returning();
  const [otherEntity] = await testDb
    .insert(entities)
    .values({ userId: otherUser!.id, name: 'Entité voisine', slug: `voisine-${Date.now()}` })
    .returning();
  foreignEntityId = otherEntity!.id;

  const [otherAgent] = await testDb
    .insert(agents)
    .values({
      entityId: foreignEntityId,
      name: 'Agent voisin',
      slug: `agent-voisin-${Date.now()}`,
      personality: 'p',
    })
    .returning();
  foreignAgentId = otherAgent!.id;
});

async function actions() {
  return import('../actions.ts');
}

let compteur = 0;
async function makePending(opts: {
  entityId: string;
  agentId: string;
  status?: string;
  role?: string;
}) {
  compteur += 1;
  const [row] = await testDb
    .insert(channelAllowedConversations)
    .values({
      entityId: opts.entityId,
      agentId: opts.agentId,
      channel: 'telegram',
      conversationId: `chat-${compteur}`,
      kind: 'private',
      role: opts.role ?? 'member',
      status: opts.status ?? 'pending',
      requesterName: 'Inconnu',
    })
    .returning();
  return row!;
}

async function rowById(id: string) {
  const [row] = await testDb
    .select()
    .from(channelAllowedConversations)
    .where(eq(channelAllowedConversations.id, id));
  return row;
}

describe('resolveChannelAllowedConversationAction — approuver', () => {
  it('fait passer la ligne de pending à active', async () => {
    const { resolveChannelAllowedConversationAction } = await actions();
    const ligne = await makePending({ entityId: seed.entityId, agentId: seed.agentId });

    const r = await resolveChannelAllowedConversationAction(ligne.id, 'approve');
    expect(r.ok, r.ok ? '' : r.message).toBe(true);

    expect((await rowById(ligne.id))?.status).toBe('active');
  });

  it('n’approuve QUE la ligne visée — les autres demandes restent en attente', async () => {
    const { resolveChannelAllowedConversationAction } = await actions();
    const cible = await makePending({ entityId: seed.entityId, agentId: seed.agentId });
    const voisine = await makePending({ entityId: seed.entityId, agentId: seed.agentId });

    await resolveChannelAllowedConversationAction(cible.id, 'approve');

    expect(
      (await rowById(voisine.id))?.status,
      'une autre demande a été approuvée en même temps',
    ).toBe('pending');
  });

  it('refuse de rejouer la décision sur une ligne déjà active', async () => {
    // Sans cette garde, un double clic ou un lien rejoué peut réactiver une
    // conversation que le propriétaire vient de révoquer.
    const { resolveChannelAllowedConversationAction } = await actions();
    const dejaActive = await makePending({
      entityId: seed.entityId,
      agentId: seed.agentId,
      status: 'active',
    });

    const r = await resolveChannelAllowedConversationAction(dejaActive.id, 'approve');
    expect(r.ok).toBe(false);

    expect((await rowById(dejaActive.id))?.status).toBe('active');
  });
});

describe('resolveChannelAllowedConversationAction — refuser', () => {
  it('supprime la ligne au lieu de la laisser en attente', async () => {
    // Une demande refusée qui resterait `pending` réapparaîtrait dans la liste
    // à chaque visite, et le propriétaire finirait par l'approuver par lassitude.
    const { resolveChannelAllowedConversationAction } = await actions();
    const ligne = await makePending({ entityId: seed.entityId, agentId: seed.agentId });

    const r = await resolveChannelAllowedConversationAction(ligne.id, 'deny');
    expect(r.ok, r.ok ? '' : r.message).toBe(true);

    expect(await rowById(ligne.id), 'la demande refusée est toujours là').toBeUndefined();
  });

  it('ne supprime pas les demandes voisines', async () => {
    const { resolveChannelAllowedConversationAction } = await actions();
    const cible = await makePending({ entityId: seed.entityId, agentId: seed.agentId });
    const voisine = await makePending({ entityId: seed.entityId, agentId: seed.agentId });

    await resolveChannelAllowedConversationAction(cible.id, 'deny');

    expect(await rowById(voisine.id)).toBeDefined();
  });
});

describe('resolveChannelAllowedConversationAction — étanchéité et validation', () => {
  it('ne touche PAS la demande d’un autre espace', async () => {
    // Approuver chez le voisin donnerait à un inconnu l'accès à un agent qui
    // n'est pas le nôtre — la faute la plus grave possible ici.
    const { resolveChannelAllowedConversationAction } = await actions();
    const etrangere = await makePending({
      entityId: foreignEntityId,
      agentId: foreignAgentId,
    });

    const r = await resolveChannelAllowedConversationAction(etrangere.id, 'approve');
    expect(r.ok).toBe(false);

    expect(
      (await rowById(etrangere.id))?.status,
      'une conversation d’un autre espace a été autorisée',
    ).toBe('pending');
  });

  it('ne supprime pas non plus la demande d’un autre espace quand on refuse', async () => {
    const { resolveChannelAllowedConversationAction } = await actions();
    const etrangere = await makePending({
      entityId: foreignEntityId,
      agentId: foreignAgentId,
    });

    const r = await resolveChannelAllowedConversationAction(etrangere.id, 'deny');
    expect(r.ok).toBe(false);

    expect(
      await rowById(etrangere.id),
      'une demande d’un autre espace a été supprimée',
    ).toBeDefined();
  });

  it('refuse un identifiant qui n’est pas un GUID', async () => {
    const { resolveChannelAllowedConversationAction } = await actions();
    const r = await resolveChannelAllowedConversationAction('pas-un-guid', 'approve');
    expect(r.ok).toBe(false);
  });
});

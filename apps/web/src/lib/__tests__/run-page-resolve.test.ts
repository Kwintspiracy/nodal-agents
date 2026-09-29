// run-page-resolve.test.ts — #501, contre une VRAIE base.
//
// La cloche, une approbation, la liste des runs et la table Runs ouvraient
// `/jobs/<id>` : le rail basculait sur Scheduled pour N'IMPORTE QUEL run,
// celui d'une conversation compris. Ils ouvrent maintenant `/runs/<id>`, et
// cette route redirige vers l'adresse que `resolveRunPageHrefAction` rend.
//
// Ce fichier prouve que cette adresse se lit sur la TÊTE de la chaîne, en
// base : un délégué d'un run de cron appartient à Scheduled, même s'il n'a lui
// aucun déclencheur ; un délégué d'une conversation appartient à Work.
//
// Mutation vérifiée : la remontée de chaîne retirée (la section lue sur le job
// lui-même) → « le délégué d'un run de cron » rougit.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs } from '@nodal-agents/db';

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

const ids: Record<string, string> = {};

async function job(
  cle: string,
  values: Partial<typeof agentJobs.$inferInsert> & { channel: string },
): Promise<string> {
  const [row] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      task: cle,
      status: 'completed',
      ...values,
    })
    .returning({ id: agentJobs.id });
  ids[cle] = row!.id;
  return row!.id;
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  const cron = await job('cron', {
    channel: 'telegram',
    chatId: 'c1',
    triggerContext: { type: 'cron', scheduleName: 'Veille', prevRunAt: null },
  });
  await job('delegue-du-cron', { channel: 'internal', parentJobId: cron });
  await job('webhook', {
    channel: 'internal',
    triggerContext: {
      type: 'webhook',
      webhookName: 'Stripe',
      slug: 'stripe',
      triggeredAt: '2026-09-27T10:00:00Z',
    },
  });
  const conversation = await job('conversation', { channel: 'dashboard' });
  await job('delegue-de-la-conversation', { channel: 'internal', parentJobId: conversation });
  await job('mcp', {
    channel: 'mcp',
    triggerContext: { type: 'mcp', triggeredAt: '2026-09-27T10:00:00Z' },
  });
});

async function adresse(cle: string): Promise<string> {
  const { resolveRunPageHrefAction } = await import('../conversation-actions.ts');
  const r = await resolveRunPageHrefAction(ids[cle] ?? '');
  if (!r.ok) throw new Error(`${r.code} ${r.message}`);
  return r.data;
}

describe('resolveRunPageHrefAction — la section d’un run se lit sur sa tête (#501) @cap:suivre-execution/moteur', () => {
  it('un run de cron et un run de webhook s’ouvrent sous Scheduled', async () => {
    expect(await adresse('cron')).toBe(`/jobs/${ids.cron}`);
    expect(await adresse('webhook')).toBe(`/jobs/${ids.webhook}`);
  });

  it('le délégué d’un run de cron s’ouvre sous Scheduled, sans déclencheur à lui', async () => {
    expect(await adresse('delegue-du-cron')).toBe(`/jobs/${ids['delegue-du-cron']}`);
  });

  it('un run de conversation, son délégué et un run MCP s’ouvrent sous Work', async () => {
    expect(await adresse('conversation')).toBe(`/chat/runs/${ids.conversation}`);
    expect(await adresse('delegue-de-la-conversation')).toBe(
      `/chat/runs/${ids['delegue-de-la-conversation']}`,
    );
    expect(await adresse('mcp')).toBe(`/chat/runs/${ids.mcp}`);
  });

  it('un run qui n’existe pas : not_found, jamais une adresse devinée', async () => {
    const { resolveRunPageHrefAction } = await import('../conversation-actions.ts');
    const r = await resolveRunPageHrefAction('00000000-0000-4000-8000-000000000000');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('not_found');
  });
});

// destructive-actions.test.ts — lot 1, les quatre actions qui DÉTRUISENT.
//
// Le plan des tests manquants classe les 62 unités non couvertes par danger,
// pas par ordre alphabétique. Celles-ci arrivent en tête parce qu'une régression
// y est irréversible : une ligne effacée ne revient pas, un fichier non plus.
//
// Les assertions portent donc toutes sur ce qui RESTE après l'appel — la ligne
// voisine, le fichier du dossier parent, l'espace de l'autre entité. Un test qui
// se contente de vérifier `r.ok` ne dit rien du périmètre de la destruction, et
// c'est exactement le périmètre qui est en jeu ici.
//
// Le secret du runner est posé dans `beforeAll`, avant le premier import
// dynamique d'`actions.ts` : `env.ts` fige `process.env` à son chargement, et
// `uninstallCommunitySkillAction` refuse de partir sans ce secret.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  and,
  agents,
  agentWorkspaces,
  conversations,
  entities,
  entityMembers,
  users,
} from '@nodal-agents/db';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** Entité voisine + son agent : le décor de toutes les preuves d'étanchéité. */
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
  process.env['WORKER_SECRET'] = 'test-worker-secret';

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

  // Le voisin : un autre utilisateur, son entité, son agent. Rien de ce qui suit
  // ne doit pouvoir le toucher.
  const [otherUser] = await testDb
    .insert(users)
    .values({ email: `voisin-${Date.now()}@example.com` })
    .returning();
  const [otherEntity] = await testDb
    .insert(entities)
    .values({
      userId: otherUser!.id,
      name: 'Entité voisine',
      slug: `voisine-${Date.now()}`,
    })
    .returning();
  foreignEntityId = otherEntity!.id;

  const [otherAgent] = await testDb
    .insert(agents)
    .values({
      entityId: foreignEntityId,
      name: 'Agent voisin',
      slug: `agent-voisin-${Date.now()}`,
      personality: 'Agent d’une autre entité.',
    })
    .returning();
  foreignAgentId = otherAgent!.id;
});

async function actions() {
  return import('../actions.ts');
}

// ─── deleteConversationAction ────────────────────────────────────────────────

describe('deleteConversationAction', () => {
  async function makeConversation(entityId: string, agentId: string, title: string) {
    const [row] = await testDb
      .insert(conversations)
      .values({ entityId, agentId, title })
      .returning();
    return row!.id;
  }

  it('supprime la conversation visée et laisse les autres intactes', async () => {
    const { deleteConversationAction } = await actions();
    const cible = await makeConversation(seed.entityId, seed.agentId, 'À supprimer');
    const voisine = await makeConversation(seed.entityId, seed.agentId, 'À garder');

    const r = await deleteConversationAction(cible);
    expect(r.ok, r.ok ? '' : r.message).toBe(true);

    expect(
      (await testDb.select().from(conversations).where(eq(conversations.id, cible))).length,
    ).toBe(0);
    // La conversation voisine du même espace ne doit pas partir avec.
    expect(
      (await testDb.select().from(conversations).where(eq(conversations.id, voisine))).length,
    ).toBe(1);
  });

  it('ne touche PAS la conversation d’une autre entité', async () => {
    // Garde IDOR : le `and(id, entityId)` du where est la seule chose qui sépare
    // « supprimer ma conversation » de « supprimer celle du voisin ».
    const { deleteConversationAction } = await actions();
    const etrangere = await makeConversation(foreignEntityId, foreignAgentId, 'Chez le voisin');

    await deleteConversationAction(etrangere);

    const rows = await testDb.select().from(conversations).where(eq(conversations.id, etrangere));
    expect(rows, 'la conversation d’une autre entité a été supprimée').toHaveLength(1);
  });

  it('renvoie ok sans rien supprimer quand l’id est inconnu — succès silencieux assumé', async () => {
    // Comportement consigné, pas approuvé : le DELETE scopé ne distingue pas
    // « rien à supprimer » de « supprimé ». L'écriture est sûre (rien ne part),
    // seul le message l'est moins. Consigné ici pour qu'un changement de ce
    // contrat soit un choix, pas une surprise.
    const { deleteConversationAction } = await actions();
    const avant = (await testDb.select().from(conversations)).length;

    const r = await deleteConversationAction('00000000-0000-4000-8000-000000000000');
    expect(r.ok).toBe(true);

    expect((await testDb.select().from(conversations)).length).toBe(avant);
  });

  it('refuse un identifiant qui n’est pas un GUID', async () => {
    const { deleteConversationAction } = await actions();
    const avant = (await testDb.select().from(conversations)).length;

    const r = await deleteConversationAction('pas-un-guid');
    expect(r.ok).toBe(false);

    expect((await testDb.select().from(conversations)).length).toBe(avant);
  });
});

// ─── removeAgentWorkspaceAction ──────────────────────────────────────────────

describe('removeAgentWorkspaceAction', () => {
  async function makeWorkspace(agentId: string, entityId: string, label: string) {
    const [row] = await testDb
      .insert(agentWorkspaces)
      .values({ agentId, entityId, label, path: join(tmpdir(), label) })
      .returning();
    return row!.id;
  }

  it('retire l’espace de travail visé, et lui seul', async () => {
    const { removeAgentWorkspaceAction } = await actions();
    const cible = await makeWorkspace(seed.agentId, seed.entityId, `ws-cible-${Date.now()}`);
    const voisin = await makeWorkspace(seed.agentId, seed.entityId, `ws-voisin-${Date.now()}`);

    const r = await removeAgentWorkspaceAction(cible);
    expect(r.ok, r.ok ? '' : r.message).toBe(true);

    expect(
      (await testDb.select().from(agentWorkspaces).where(eq(agentWorkspaces.id, cible))).length,
    ).toBe(0);
    expect(
      (await testDb.select().from(agentWorkspaces).where(eq(agentWorkspaces.id, voisin))).length,
    ).toBe(1);
  });

  it('refuse l’espace d’un agent d’une autre entité — et la ligne reste', async () => {
    // La garde passe par une jointure vers `agents` : connaître le GUID d'un
    // agent_workspace ne doit pas suffire à retirer le dossier d'un autre.
    const { removeAgentWorkspaceAction } = await actions();
    const etranger = await makeWorkspace(
      foreignAgentId,
      foreignEntityId,
      `ws-etranger-${Date.now()}`,
    );

    const r = await removeAgentWorkspaceAction(etranger);
    expect(r.ok).toBe(false);

    expect(
      (await testDb.select().from(agentWorkspaces).where(eq(agentWorkspaces.id, etranger))).length,
      'l’espace de travail d’une autre entité a été retiré',
    ).toBe(1);
  });

  it('refuse un identifiant qui n’est pas un GUID', async () => {
    const { removeAgentWorkspaceAction } = await actions();
    const r = await removeAgentWorkspaceAction('pas-un-guid');
    expect(r.ok).toBe(false);
  });
});

// ─── deleteWorkspaceFileAction ───────────────────────────────────────────────

describe('deleteWorkspaceFileAction', () => {
  // Vrais fichiers sur un vrai disque : l'action appelle `unlink`, et la garde
  // qu'on veut prouver (traversée de chemin) ne se voit que sur le disque.
  let parentDir: string;
  let wsDir: string;
  const LABEL = 'docs';

  beforeAll(async () => {
    parentDir = await mkdtemp(join(tmpdir(), 'nodal-ws-'));
    wsDir = await mkdtemp(join(parentDir, 'espace-'));
    await writeFile(join(parentDir, 'secret.txt'), 'ce fichier est HORS de l’espace');
    await testDb.insert(agentWorkspaces).values({
      agentId: seed.agentId,
      entityId: seed.entityId,
      label: LABEL,
      path: wsDir,
    });
  });

  afterAll(async () => {
    await rm(parentDir, { recursive: true, force: true });
  });

  it('supprime le fichier visé et laisse les autres dans le dossier', async () => {
    const { deleteWorkspaceFileAction } = await actions();
    await writeFile(join(wsDir, 'note.md'), 'à supprimer');
    await writeFile(join(wsDir, 'garde.md'), 'à garder');

    const r = await deleteWorkspaceFileAction(seed.agentId, LABEL, 'note.md');
    expect(r.ok, r.ok ? '' : r.message).toBe(true);

    const restants = await readdir(wsDir);
    expect(restants).not.toContain('note.md');
    expect(restants).toContain('garde.md');
  });

  it('ne sort JAMAIS du dossier de l’espace — `../secret.txt` laisse le parent intact', async () => {
    // `basename` ramène la cible dans le dossier ; la preuve utile n'est pas le
    // code de retour mais le fichier du dossier parent, toujours là après coup.
    const { deleteWorkspaceFileAction } = await actions();

    const r = await deleteWorkspaceFileAction(seed.agentId, LABEL, '../secret.txt');
    expect(r.ok).toBe(false);

    const parentFiles = await readdir(parentDir);
    expect(parentFiles, 'un fichier hors de l’espace a été supprimé').toContain('secret.txt');
  });

  it('refuse un nom de fichier commençant par un point', async () => {
    const { deleteWorkspaceFileAction } = await actions();
    await writeFile(join(wsDir, '.env'), 'SECRET=1');

    const r = await deleteWorkspaceFileAction(seed.agentId, LABEL, '.env');
    expect(r.ok).toBe(false);

    expect(await readdir(wsDir)).toContain('.env');
  });

  it('refuse l’agent d’une autre entité — le fichier reste', async () => {
    const { deleteWorkspaceFileAction } = await actions();
    await writeFile(join(wsDir, 'convoité.md'), 'contenu');

    // Même label, mais l'agent appartient au voisin : la garde de propriété doit
    // tomber avant toute résolution de chemin.
    const r = await deleteWorkspaceFileAction(foreignAgentId, LABEL, 'convoité.md');
    expect(r.ok).toBe(false);

    expect(await readdir(wsDir)).toContain('convoité.md');
  });

  it('signale un fichier absent au lieu de prétendre l’avoir supprimé', async () => {
    const { deleteWorkspaceFileAction } = await actions();
    const r = await deleteWorkspaceFileAction(seed.agentId, LABEL, 'jamais-existé.md');
    expect(r.ok).toBe(false);
  });
});

// ─── uninstallCommunitySkillAction ───────────────────────────────────────────

describe('uninstallCommunitySkillAction', () => {
  // L'action ne touche pas la base : elle délègue au runner. Ce qu'on peut — et
  // doit — prouver, c'est le CONTENU de la requête sortante. L'entityId qui y
  // figure est ce qui empêche une désinstallation de déborder sur un autre
  // espace ; s'il disparaissait du corps, aucun test de code de retour ne le
  // verrait.
  it('envoie le slug ET l’entityId de la session au runner', async () => {
    const { uninstallCommunitySkillAction } = await actions();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    try {
      const r = await uninstallCommunitySkillAction('pdf-toolkit');
      expect(r.ok, r.ok ? '' : r.message).toBe(true);

      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toContain('/api/skills/uninstall');
      const body = JSON.parse(String((init as RequestInit).body)) as {
        slug: string;
        entityId: string;
      };
      expect(body.slug).toBe('pdf-toolkit');
      expect(body.entityId).toBe(seed.entityId);

      const auth = (init as RequestInit).headers as Record<string, string>;
      expect(auth['Authorization']).toBe('Bearer test-worker-secret');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('remonte l’échec du runner au lieu d’annoncer une désinstallation', async () => {
    // Le motif du bug `setAgentApprovalRuleAction` : un `ok` renvoyé alors que
    // rien n'a été fait. Ici le runner refuse — l'action doit refuser aussi.
    const { uninstallCommunitySkillAction } = await actions();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'not_found', message: 'Skill absente' }), {
        status: 200,
      }),
    );

    try {
      const r = await uninstallCommunitySkillAction('inexistante');
      expect(r.ok).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('échoue proprement quand le runner est injoignable', async () => {
    const { uninstallCommunitySkillAction } = await actions();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('connect ECONNREFUSED'));

    try {
      const r = await uninstallCommunitySkillAction('pdf-toolkit');
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.code).toBe('network_error');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('refuse un slug vide sans appeler le runner', async () => {
    const { uninstallCommunitySkillAction } = await actions();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    try {
      const r = await uninstallCommunitySkillAction('');
      expect(r.ok).toBe(false);
      // Rien ne doit partir : une requête émise avec un slug vide dépendrait de
      // la validation du runner pour ne pas faire de dégât.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

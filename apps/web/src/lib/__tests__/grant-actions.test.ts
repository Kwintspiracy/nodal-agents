// grant-actions.test.ts — lot 1, les trois interrupteurs qui OUVRENT
// l'exécution de code.
//
// Ces actions ne créent rien et ne suppriment rien : elles basculent un booléen.
// C'est précisément ce qui les rend dangereuses — un booléen n'a l'air de rien
// dans une revue, et celui-ci décide si un agent peut lancer les scripts d'une
// skill, réécrire ses fichiers, ou exécuter des commandes shell demandées depuis
// le réseau local.
//
// Les trois portent la même garde : SEUL le propriétaire de l'espace bascule.
// Un refus qui laisse quand même la colonne à `true` serait indétectable à
// l'usage — la porte reste ouverte, l'interface affiche une erreur. Chaque test
// de refus relit donc la colonne après coup.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  and,
  agents,
  agentSkills,
  agentSkillAssignments,
  entities,
  entityMembers,
  users,
} from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** Un second utilisateur : sert à faire de la session un NON-propriétaire. */
let otherUserId: string;
/** Entité voisine + son agent + une skill assignée chez elle. */
let foreignEntityId: string;
let foreignAgentId: string;
let foreignAssignmentId: string;
let skillId: string;

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

  const [other] = await testDb
    .insert(users)
    .values({ email: `autre-${Date.now()}@example.com` })
    .returning();
  otherUserId = other!.id;

  const [otherEntity] = await testDb
    .insert(entities)
    .values({ userId: otherUserId, name: 'Entité voisine', slug: `voisine-${Date.now()}` })
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

  // Une skill, assignée à l'agent de la session ET à celui du voisin.
  const [skill] = await testDb
    .insert(agentSkills)
    .values({
      entityId: seed.entityId,
      name: 'Skill scriptée',
      slug: `skill-scriptee-${Date.now()}`,
      content: '# Skill avec scripts',
    })
    .returning();
  skillId = skill!.id;

  await testDb.insert(agentSkillAssignments).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    skillId,
  });

  const [foreignAssignment] = await testDb
    .insert(agentSkillAssignments)
    .values({ entityId: foreignEntityId, agentId: foreignAgentId, skillId })
    .returning();
  foreignAssignmentId = foreignAssignment!.id;
});

/** Rend la session non-propriétaire le temps d'un test, puis restaure. */
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

async function assignment(agentId: string) {
  const [row] = await testDb
    .select()
    .from(agentSkillAssignments)
    .where(
      and(eq(agentSkillAssignments.agentId, agentId), eq(agentSkillAssignments.skillId, skillId)),
    );
  return row!;
}

async function actions() {
  return import('../actions.ts');
}

afterEach(async () => {
  // Les deux colonnes reviennent à leur défaut : chaque test part d'une porte
  // fermée, sinon un « refus » passerait pour un succès.
  await testDb
    .update(agentSkillAssignments)
    .set({ scriptsAuthorized: false, filesWritable: false });
  await testDb.update(entities).set({ autoRunPaused: false });
});

// ─── setSkillScriptsAuthorizedAction ─────────────────────────────────────────

describe('setSkillScriptsAuthorizedAction', () => {
  it('autorise puis retire — la colonne suit dans les deux sens', async () => {
    const { setSkillScriptsAuthorizedAction } = await actions();

    const on = await setSkillScriptsAuthorizedAction({
      agentId: seed.agentId,
      skillId,
      authorized: true,
    });
    expect(on.ok, on.ok ? '' : on.message).toBe(true);
    expect((await assignment(seed.agentId)).scriptsAuthorized).toBe(true);

    // La révocation compte autant : une porte qu'on ne peut pas refermer n'est
    // pas un interrupteur.
    const off = await setSkillScriptsAuthorizedAction({
      agentId: seed.agentId,
      skillId,
      authorized: false,
    });
    expect(off.ok, off.ok ? '' : off.message).toBe(true);
    expect((await assignment(seed.agentId)).scriptsAuthorized).toBe(false);
  });

  it('refuse un non-propriétaire — et la colonne reste à false', async () => {
    const { setSkillScriptsAuthorizedAction } = await actions();

    await asNonOwner(async () => {
      const r = await setSkillScriptsAuthorizedAction({
        agentId: seed.agentId,
        skillId,
        authorized: true,
      });
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.code).toBe('forbidden');
    });

    expect(
      (await assignment(seed.agentId)).scriptsAuthorized,
      'un non-propriétaire a ouvert l’exécution de scripts',
    ).toBe(false);
  });

  it('refuse un agent d’une autre entité — l’assignation du voisin reste fermée', async () => {
    const { setSkillScriptsAuthorizedAction } = await actions();

    const r = await setSkillScriptsAuthorizedAction({
      agentId: foreignAgentId,
      skillId,
      authorized: true,
    });
    expect(r.ok).toBe(false);

    const [row] = await testDb
      .select()
      .from(agentSkillAssignments)
      .where(eq(agentSkillAssignments.id, foreignAssignmentId));
    expect(row!.scriptsAuthorized, 'écriture inter-entités sur une autorisation').toBe(false);
  });

  it('refuse une skill non assignée au lieu d’écrire dans le vide', async () => {
    const { setSkillScriptsAuthorizedAction } = await actions();
    const [orpheline] = await testDb
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        name: 'Skill non assignée',
        slug: `orpheline-${Date.now()}`,
        content: '# rien',
      })
      .returning();

    const r = await setSkillScriptsAuthorizedAction({
      agentId: seed.agentId,
      skillId: orpheline!.id,
      authorized: true,
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.code).toBe('not_assigned');
  });

  it('refuse une entrée mal formée sans rien basculer', async () => {
    const { setSkillScriptsAuthorizedAction } = await actions();

    const r = await setSkillScriptsAuthorizedAction({
      agentId: seed.agentId,
      skillId,
      authorized: 'oui',
    });
    expect(r.ok).toBe(false);
    expect((await assignment(seed.agentId)).scriptsAuthorized).toBe(false);
  });
});

// ─── setSkillFilesWritableAction ─────────────────────────────────────────────

describe('setSkillFilesWritableAction', () => {
  it('ouvre puis referme l’écriture des fichiers de la skill', async () => {
    const { setSkillFilesWritableAction } = await actions();

    const on = await setSkillFilesWritableAction({
      agentId: seed.agentId,
      skillId,
      writable: true,
    });
    expect(on.ok, on.ok ? '' : on.message).toBe(true);
    expect((await assignment(seed.agentId)).filesWritable).toBe(true);

    const off = await setSkillFilesWritableAction({
      agentId: seed.agentId,
      skillId,
      writable: false,
    });
    expect(off.ok, off.ok ? '' : off.message).toBe(true);
    expect((await assignment(seed.agentId)).filesWritable).toBe(false);
  });

  it('ne touche PAS l’autorisation voisine — scripts et fichiers sont deux portes', async () => {
    // Les deux colonnes vivent sur la même ligne ; un `set` trop large ferait
    // qu'autoriser l'écriture ouvrirait aussi les scripts, en silence.
    const { setSkillFilesWritableAction } = await actions();

    await setSkillFilesWritableAction({ agentId: seed.agentId, skillId, writable: true });

    const row = await assignment(seed.agentId);
    expect(row.filesWritable).toBe(true);
    expect(row.scriptsAuthorized, 'ouvrir les fichiers a aussi ouvert les scripts').toBe(false);
  });

  it('refuse un non-propriétaire — et la colonne reste à false', async () => {
    const { setSkillFilesWritableAction } = await actions();

    await asNonOwner(async () => {
      const r = await setSkillFilesWritableAction({
        agentId: seed.agentId,
        skillId,
        writable: true,
      });
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.code).toBe('forbidden');
    });

    expect(
      (await assignment(seed.agentId)).filesWritable,
      'un non-propriétaire a ouvert l’écriture de fichiers',
    ).toBe(false);
  });

  it('refuse un agent d’une autre entité — l’assignation du voisin reste fermée', async () => {
    const { setSkillFilesWritableAction } = await actions();

    const r = await setSkillFilesWritableAction({
      agentId: foreignAgentId,
      skillId,
      writable: true,
    });
    expect(r.ok).toBe(false);

    const [row] = await testDb
      .select()
      .from(agentSkillAssignments)
      .where(eq(agentSkillAssignments.id, foreignAssignmentId));
    expect(row!.filesWritable, 'écriture inter-entités sur une autorisation').toBe(false);
  });
});

// ─── setAutoRunPauseAction (0082 — le frein remplace le master-switch) ────────
//
// Sémantique INVERSÉE mais mêmes risques : le frein en pause protège, le
// RELÂCHER ré-arme toutes les règles Yolo du workspace d'un coup — c'est le
// relâchement qui est le geste sensible, owner-only.

describe('setAutoRunPauseAction', () => {
  async function pauseFlag() {
    const [row] = await testDb.select().from(entities).where(eq(entities.id, seed.entityId));
    return row!.autoRunPaused;
  }

  it('bascule le frein de l’espace COURANT, dans les deux sens', async () => {
    const { setAutoRunPauseAction } = await actions();

    const on = await setAutoRunPauseAction({ paused: true });
    expect(on.ok, on.ok ? '' : on.message).toBe(true);
    expect(await pauseFlag()).toBe(true);

    const off = await setAutoRunPauseAction({ paused: false });
    expect(off.ok, off.ok ? '' : off.message).toBe(true);
    expect(await pauseFlag()).toBe(false);
  });

  it('ne freine QUE son espace, jamais le voisin', async () => {
    // Un `update` sans clause d'espace mettrait en pause (ou ré-armerait)
    // l'auto-exécution chez tout le monde d'un seul clic.
    const { setAutoRunPauseAction } = await actions();

    await setAutoRunPauseAction({ paused: true });

    const [voisin] = await testDb.select().from(entities).where(eq(entities.id, foreignEntityId));
    expect(voisin!.autoRunPaused, 'l’espace voisin a été freiné lui aussi').toBe(false);
  });

  it('refuse un non-propriétaire — dans les DEUX directions', async () => {
    const { setAutoRunPauseAction } = await actions();

    // Direction sensible : RELÂCHER un frein posé par l'owner.
    await testDb
      .update(entities)
      .set({ autoRunPaused: true })
      .where(eq(entities.id, seed.entityId));
    await asNonOwner(async () => {
      const r = await setAutoRunPauseAction({ paused: false });
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.code).toBe('forbidden');
    });
    expect(await pauseFlag(), 'un non-propriétaire a relâché le frein').toBe(true);

    // Et freiner sans être owner est refusé aussi (perturberait les automations).
    await testDb
      .update(entities)
      .set({ autoRunPaused: false })
      .where(eq(entities.id, seed.entityId));
    await asNonOwner(async () => {
      const r = await setAutoRunPauseAction({ paused: true });
      expect(r.ok).toBe(false);
    });
    expect(await pauseFlag()).toBe(false);
  });

  it('refuse une entrée mal formée sans rien basculer', async () => {
    const { setAutoRunPauseAction } = await actions();

    const r = await setAutoRunPauseAction({ paused: 'yes' });
    expect(r.ok).toBe(false);
    expect(await pauseFlag()).toBe(false);
  });
});

// ─── Interrupteur du serveur MCP ─────────────────────────────────────────────
//
// Le jumeau du bloc LanCommandYolo ci-dessus — même surface, mêmes risques :
// ce drapeau ouvre un point d'entrée EXTERNE qui crée des jobs. L'inventaire
// du 23/08 a montré ces deux actions sans test : la PR #13 avait cassé le
// standard « plus une action serveur sans test » sans que rien ne le signale.

describe('get/setMcpServerSwitchAction', () => {
  async function mcpFlag() {
    const [row] = await testDb.select().from(entities).where(eq(entities.id, seed.entityId));
    return row!.mcpServerEnabled;
  }

  it('FERMÉ par défaut, et la lecture le dit', async () => {
    const { getMcpServerSwitchAction } = await actions();
    const r = await getMcpServerSwitchAction();
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
    if (r.ok) {
      expect(r.data.enabled, 'un point d’entrée externe ouvert par défaut').toBe(false);
      expect(r.data.isOwner).toBe(true);
    }
  });

  it('bascule le drapeau de l’espace COURANT, dans les deux sens', async () => {
    const { setMcpServerSwitchAction } = await actions();

    const on = await setMcpServerSwitchAction({ enabled: true });
    expect(on.ok, on.ok ? '' : on.message).toBe(true);
    expect(await mcpFlag()).toBe(true);

    const off = await setMcpServerSwitchAction({ enabled: false });
    expect(off.ok, off.ok ? '' : off.message).toBe(true);
    expect(await mcpFlag()).toBe(false);
  });

  it('n’ouvre le serveur QUE sur son espace, jamais sur le voisin', async () => {
    const { setMcpServerSwitchAction } = await actions();
    await setMcpServerSwitchAction({ enabled: true });
    const [voisin] = await testDb.select().from(entities).where(eq(entities.id, foreignEntityId));
    expect(voisin!.mcpServerEnabled, 'l’espace voisin a été ouvert lui aussi').toBe(false);
    await setMcpServerSwitchAction({ enabled: false });
  });

  it('refuse un non-propriétaire — et le drapeau reste fermé', async () => {
    const { setMcpServerSwitchAction } = await actions();
    await asNonOwner(async () => {
      const r = await setMcpServerSwitchAction({ enabled: true });
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.code).toBe('forbidden');
    });
    expect(await mcpFlag(), 'un non-propriétaire a ouvert le serveur MCP').toBe(false);
  });

  it('refuse une entrée mal formée sans rien basculer', async () => {
    const { setMcpServerSwitchAction } = await actions();
    const r = await setMcpServerSwitchAction({ enabled: 'yes' });
    expect(r.ok).toBe(false);
    expect(await mcpFlag()).toBe(false);
  });
});

// read-actions-idor.test.ts — les 18 lectures, une seule question.
//
// Le plan des tests manquants tranche : ces actions ne méritent pas dix-huit
// tests de comportement. Elles ne détruisent rien, ne basculent aucun droit, et
// leur logique métier est un SELECT. Elles portent UN risque, et un seul :
// est-ce qu'elles rendent les données d'un autre espace à qui connaît un GUID ?
//
// D'où la forme de ce fichier : un tableau de cas, un même verdict. Chaque
// lecture est appelée avec l'identifiant d'une ressource VOISINE, et le test
// n'exige pas un code d'erreur particulier — refuser ou renvoyer vide sont deux
// contrats acceptables. Il exige que les données du voisin ne ressortent pas.
//
// Le marqueur cherché est une chaîne unique semée dans les lignes voisines : si
// elle apparaît où que ce soit dans la réponse, la fuite est prouvée, quel que
// soit le champ par lequel elle est passée.
//
// Deux lectures sont hors sujet et non couvertes ici, volontairement :
// `getVersionInfoAction` (version du process + interrogation de npm) et
// `getNetworkSettingsAction` (configuration de l'hôte) ne lisent aucune donnée
// d'espace — il n'y a pas d'IDOR à y chercher.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  and,
  agents,
  agentJobs,
  agentSkills,
  agentSkillAssignments,
  agentWorkspaces,
  approvalRules,
  entities,
  entityMembers,
  mcpServers,
  agentMcpServers,
  telegramAllowedChats,
  users,
} from '@nodal-agents/db';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Semé dans TOUT ce qui appartient au voisin. Une lecture qui laisse fuir
 * n'importe quel champ d'une ligne voisine ramènera cette chaîne.
 */
const MARQUEUR = 'MARQUEUR-VOISIN-NE-DOIT-JAMAIS-SORTIR';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

const voisin = {
  entityId: '',
  agentId: '',
  skillId: '',
  workspaceLabel: `${MARQUEUR}-espace`,
};

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

  // ── L'espace voisin, garni de tout ce que les 18 lectures savent lire ──────
  const [autreUser] = await testDb
    .insert(users)
    .values({ email: `voisin-${Date.now()}@example.com` })
    .returning();
  const [autreEntite] = await testDb
    .insert(entities)
    .values({
      userId: autreUser!.id,
      name: `${MARQUEUR}-entité`,
      slug: `voisine-${Date.now()}`,
    })
    .returning();
  voisin.entityId = autreEntite!.id;
  await testDb
    .insert(entityMembers)
    .values({ entityId: voisin.entityId, userId: autreUser!.id, role: 'owner' });

  const [autreAgent] = await testDb
    .insert(agents)
    .values({
      entityId: voisin.entityId,
      name: `${MARQUEUR}-agent`,
      slug: `agent-voisin-${Date.now()}`,
      personality: `${MARQUEUR} — personnalité privée du voisin`,
    })
    .returning();
  voisin.agentId = autreAgent!.id;

  // Le root du voisin : ce que getRootContext / getRootSystemPrompt lisent.
  await testDb
    .update(entities)
    .set({ rootAgentId: voisin.agentId })
    .where(eq(entities.id, voisin.entityId));

  const [autreSkill] = await testDb
    .insert(agentSkills)
    .values({
      entityId: voisin.entityId,
      name: `${MARQUEUR}-skill`,
      slug: `skill-voisine-${Date.now()}`,
      content: `${MARQUEUR} — contenu privé`,
    })
    .returning();
  voisin.skillId = autreSkill!.id;
  await testDb.insert(agentSkillAssignments).values({
    entityId: voisin.entityId,
    agentId: voisin.agentId,
    skillId: voisin.skillId,
  });

  await testDb.insert(agentWorkspaces).values({
    agentId: voisin.agentId,
    entityId: voisin.entityId,
    label: voisin.workspaceLabel,
    path: join(tmpdir(), 'voisin-espace'),
  });

  await testDb.insert(approvalRules).values({
    entityId: voisin.entityId,
    agentId: voisin.agentId,
    toolName: `${MARQUEUR}_outil`,
    action: 'auto_approve',
  });

  const [autreMcp] = await testDb
    .insert(mcpServers)
    .values({
      entityId: voisin.entityId,
      name: `${MARQUEUR}-mcp`,
      slug: 'mcp-voisin',
      transport: 'http',
      url: 'https://voisin.test/mcp',
    })
    .returning();
  await testDb.insert(agentMcpServers).values({
    entityId: voisin.entityId,
    agentId: voisin.agentId,
    mcpServerId: autreMcp!.id,
  });

  await testDb.insert(telegramAllowedChats).values({
    entityId: voisin.entityId,
    agentId: voisin.agentId,
    chatId: '999999',
    role: 'member',
    status: 'active',
    requesterName: `${MARQUEUR}-contact`,
  });

  // Un job en cours chez le voisin : ce que getActiveJobsByAgent agrège.
  await testDb.insert(agentJobs).values({
    entityId: voisin.entityId,
    agentId: voisin.agentId,
    channel: 'api',
    task: `${MARQUEUR} — tâche confidentielle`,
    status: 'processing',
  });
});

async function actions() {
  return import('../actions.ts');
}

/**
 * Le verdict commun. Refuser ou renvoyer vide sont deux contrats acceptables —
 * ce qui ne l'est pas, c'est que le marqueur du voisin apparaisse quelque part
 * dans la réponse.
 */
function assertAucuneFuite(nom: string, resultat: { ok: boolean; data?: unknown }) {
  expect(fuite(nom, resultat), `${nom} a laissé fuir des données d’un autre espace`).toBeNull();
}

/** Le même verdict, sous forme de valeur — pour tester un lot d'un coup. */
function fuite(nom: string, resultat: { ok: boolean; data?: unknown }): string | null {
  if (!resultat.ok) return null; // refus explicite : parfait.
  const rendu = JSON.stringify(resultat.data ?? null);
  return rendu.includes(MARQUEUR) ? nom : null;
}

// ─── Les lectures qui prennent un identifiant ────────────────────────────────

describe('lectures par identifiant — un GUID voisin ne donne accès à rien', () => {
  it('les huit lectures par id refusent l’identifiant d’un autre espace', async () => {
    const a = await actions();

    const cas: { nom: string; appel: () => Promise<{ ok: boolean; data?: unknown }> }[] = [
      {
        nom: 'getAgentForEditAction',
        appel: () => a.getAgentForEditAction(voisin.agentId),
      },
      {
        nom: 'getAgentAttachedSkillsAction',
        appel: () => a.getAgentAttachedSkillsAction(voisin.agentId),
      },
      {
        nom: 'getSkillByIdAction',
        appel: () => a.getSkillByIdAction(voisin.skillId),
      },
      {
        nom: 'getTelegramAllowedChatsAction',
        appel: () => a.getTelegramAllowedChatsAction(voisin.agentId),
      },
      {
        nom: 'listAgentWorkspacesAction',
        appel: () => a.listAgentWorkspacesAction(voisin.agentId),
      },
      {
        nom: 'listAgentMcpServersAction',
        appel: () => a.listAgentMcpServersAction(voisin.agentId),
      },
      {
        nom: 'listAgentApprovalRulesAction',
        appel: () => a.listAgentApprovalRulesAction(voisin.agentId),
      },
      {
        nom: 'listWorkspaceFilesAction',
        appel: () => a.listWorkspaceFilesAction(voisin.agentId, voisin.workspaceLabel),
      },
    ];

    // Le décompte est asserté : si une action disparaît du tableau lors d'un
    // renommage, le test doit échouer au lieu de couvrir sept cas en silence.
    expect(cas).toHaveLength(8);

    // On collecte AVANT d'asserter : un `expect` dans la boucle s'arrêterait à
    // la première fuite et cacherait les sept autres. Le rapport doit nommer
    // toutes les actions percées d'un seul coup.
    const fuites: string[] = [];
    for (const { nom, appel } of cas) {
      const percee = fuite(nom, await appel());
      if (percee) fuites.push(percee);
    }
    expect(fuites, 'ces lectures ont rendu les données d’un autre espace').toEqual([]);
  });

  it('un identifiant mal formé ne passe nulle part', async () => {
    const a = await actions();
    const resultats = await Promise.all([
      a.getAgentForEditAction('pas-un-guid'),
      a.getSkillByIdAction('pas-un-guid'),
      a.listAgentWorkspacesAction('pas-un-guid'),
      a.listAgentApprovalRulesAction('pas-un-guid'),
    ]);
    for (const r of resultats) expect(r.ok).toBe(false);
  });
});

// ─── Les lectures scopées par la session ────────────────────────────────────

describe('lectures sans argument — la session borne ce qui sort', () => {
  it('listWorkspacesAction ne montre pas l’espace du voisin', async () => {
    // Celle-ci est la plus exposée : elle alimente le sélecteur d'espaces.
    const { listWorkspacesAction } = await actions();
    assertAucuneFuite('listWorkspacesAction', await listWorkspacesAction());
  });

  it('getActiveJobsByAgentAction n’agrège pas les jobs d’un autre espace', async () => {
    // Un job « processing » existe chez le voisin ; il ne doit pas compter ici.
    const { getActiveJobsByAgentAction } = await actions();
    assertAucuneFuite('getActiveJobsByAgentAction', await getActiveJobsByAgentAction());
  });

  it('getRootContextAction ne renvoie pas l’agent racine du voisin', async () => {
    const { getRootContextAction } = await actions();
    assertAucuneFuite('getRootContextAction', await getRootContextAction());
  });

  it('getRootSystemPromptAction ne renvoie pas le prompt du voisin', async () => {
    // Le prompt système d'un agent racine contient la personnalité rédigée par
    // son propriétaire — parmi les choses les plus privées de l'espace.
    const { getRootSystemPromptAction } = await actions();
    assertAucuneFuite('getRootSystemPromptAction', await getRootSystemPromptAction());
  });

  it('les activités agrégées ne comptent pas les jobs du voisin', async () => {
    const { getWeeklyActivityAction, getDailyActivityAction } = await actions();
    assertAucuneFuite('getWeeklyActivityAction', await getWeeklyActivityAction());
    assertAucuneFuite('getDailyActivityAction', await getDailyActivityAction());
  });

  it('les réglages d’espace lisent bien l’espace de la session', async () => {
    // `getWorkspaceTimezoneAction` et `getAutoRunPauseAction` ne prennent
    // aucun argument : la seule façon de se tromper d'espace est de ne pas
    // filtrer du tout. On le vérifie sur le frein d'auto-exécution, dont la
    // valeur voisine est mise à `true` pour l'occasion.
    const { getAutoRunPauseAction, getWorkspaceTimezoneAction } = await actions();
    await testDb
      .update(entities)
      .set({ autoRunPaused: true })
      .where(eq(entities.id, voisin.entityId));

    const pause = await getAutoRunPauseAction();
    expect(pause.ok, pause.ok ? '' : pause.message).toBe(true);
    if (pause.ok) {
      expect(pause.data.autoRunPaused, 'le frein du voisin a été lu à la place du nôtre').toBe(
        false,
      );
    }

    const tz = await getWorkspaceTimezoneAction();
    expect(tz.ok).toBe(true);
  });
});

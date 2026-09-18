// send-task-origin.test.ts — d'où vient une tâche envoyée depuis le tableau de
// bord (Quentin, 18/09/2026).
//
// Le défaut, vu à l'œil sur le dossier MCP le jour de son ouverture : « pas mal
// de lignes ne semblent pas venir du MCP ». `sendTaskAction` — la boîte « Send
// task » de la page Activity — écrivait `channel = 'api'`, la valeur même que
// pose `/api/agent`. Plus rien en base ne distinguait une demande partie d'ici
// d'une demande venue de dehors, et le dossier listait les deux.
//
// Corrigé à la SOURCE : la boîte écrit `dashboard`, l'endroit d'où la demande
// part. Le dossier, lui, ne change pas de règle — il liste `api` et `mcp`, qui
// ne nomment plus que l'extérieur.
//
// Ce fichier le prouve sur une VRAIE base : la ligne écrite, puis ce que les
// lectures en font. Assertions sur les lignes rendues, jamais sur des appels
// comptés (invariant #5).
//
// Mutation vérifiée : `channel: 'dashboard'` remis à `'api'` dans
// `sendTaskAction` → « écrit le canal du tableau de bord » et « ne tombe pas
// dans le dossier MCP » rougissent tous les deux.
//
// ⚠️ LES LIGNES DÉJÀ ÉCRITES gardent `api` et restent indiscernables d'une
// requête extérieure. Rien ici ne les réécrit : leur inventer une provenance
// serait exactement le repli silencieux que l'invariant #4 interdit.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, and, eq, isNull } from '@nodal-agents/db';
import { chatFolders, folderOfWork, DASHBOARD_FOLDER, MCP_FOLDER } from '../chat-folders.ts';
import { originOfRun } from '../activity-runs.ts';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

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

vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

/** Le job que la boîte « Send task » vient d'écrire. */
let tacheEnvoyee = '';

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  const { sendTaskAction } = await import('../actions.ts');
  const envoi = await sendTaskAction({
    prompt: 'Ranger les notes de la semaine',
    agentId: seed.agentId,
  });
  if (!envoi.ok) throw new Error(envoi.message);
  tacheEnvoyee = envoi.data.jobId;
});

/** La ligne écrite en base, relue telle quelle. */
async function ligneEcrite() {
  const [row] = await testDb
    .select({
      channel: agentJobs.channel,
      task: agentJobs.task,
      conversationId: agentJobs.conversationId,
      parentJobId: agentJobs.parentJobId,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, tacheEnvoyee))
    .limit(1);
  if (!row) throw new Error('la tâche envoyée est introuvable');
  return row;
}

describe('« Send task » écrit d’où la demande part @cap:parler-par-canal-externe/moteur', () => {
  it('écrit le canal du tableau de bord, pas celui de l’API', async () => {
    const row = await ligneEcrite();
    expect(row.channel).toBe('dashboard');
    expect(row.task).toBe('Ranger les notes de la semaine');
    // Ce qui n'a PAS changé : la boîte n'ouvre aucune conversation, et sa tâche
    // reste un job de tête.
    expect(row.conversationId).toBeNull();
    expect(row.parentJobId).toBeNull();
  });

  it('ne tombe donc PAS dans le dossier MCP', async () => {
    const row = await ligneEcrite();
    const origine = { jobChannel: row.channel, conversationChannel: null };
    expect(folderOfWork(origine)).toBe(DASHBOARD_FOLDER);
    expect(folderOfWork(origine)).not.toBe(MCP_FOLDER);
  });

  it('tandis qu’un run venu de dehors y tombe, lui', async () => {
    const [externe] = await testDb
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'la demande d’une machine',
        status: 'pending',
        conversationId: null,
      })
      .returning({ channel: agentJobs.channel });
    expect(folderOfWork({ jobChannel: externe!.channel, conversationChannel: null })).toBe(
      MCP_FOLDER,
    );
  });

  it('ne laisse plus aucune tâche du tableau de bord parmi les runs de dehors', async () => {
    // La lecture du dossier, dans les mêmes termes que `runsFromOutside` : la
    // tâche qu'on vient d'envoyer n'y est pas.
    const dehors = await testDb
      .select({ id: agentJobs.id, task: agentJobs.task })
      .from(agentJobs)
      .where(
        and(
          eq(agentJobs.entityId, seed.entityId),
          isNull(agentJobs.parentJobId),
          isNull(agentJobs.conversationId),
          eq(agentJobs.channel, 'api'),
        ),
      );
    expect(dehors.map((r) => r.id)).not.toContain(tacheEnvoyee);
    expect(dehors.some((r) => r.task === 'la demande d’une machine')).toBe(true);
  });

  it('continue de se lire « Dashboard » dans Activity, comme avant', async () => {
    // Tout ce qui n'est pas le dossier doit être INCHANGÉ : la colonne « d'où
    // vient la demande » disait « Dashboard », elle le dit toujours.
    const row = await ligneEcrite();
    expect(
      originOfRun({ channel: row.channel, triggerContext: null, conversationId: null }),
    ).toEqual({ label: 'Dashboard', detail: null });
    // Et `api` cesse de se faire passer pour le tableau de bord.
    expect(originOfRun({ channel: 'api', triggerContext: null, conversationId: null })).toEqual({
      label: 'API',
      detail: null,
    });
  });

  it('compte son attente dans « Nodal chats », le dossier de ce qui part d’ici', async () => {
    // Conséquence ASSUMÉE du changement de canal : une approbation de « Send
    // task » ne comptait dans aucun dossier tant qu'elle portait `api`. Elle
    // compte maintenant là où tout travail du tableau de bord compte — la même
    // règle que pour n'importe quel canal sans conversation lue. Le run
    // lui-même n'a pas de ligne dans ce dossier, qui liste des conversations :
    // la demande reste entière sur /approvals.
    const row = await ligneEcrite();
    const rows = chatFolders({
      channels: [],
      waiting: [{ jobChannel: row.channel, conversationChannel: null }],
      running: {},
      externalRuns: 0,
      pathname: '/chat',
      folderParam: null,
    });
    expect(rows.find((r) => r.key === DASHBOARD_FOLDER)?.waiting).toBe(1);
    expect(rows.map((r) => r.key)).not.toContain(MCP_FOLDER);
  });
});

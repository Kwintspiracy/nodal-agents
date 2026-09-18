// external-runs-pages.test.ts — pages et suppression du dossier MCP, sur une
// VRAIE base (#183).
//
// Deux promesses, et aucune ne se prouve sans base :
//
//   1. la liste se lit PAR PAGES, du plus récent au plus ancien, sans doublon
//      ni trou — y compris quand deux runs partagent la même date à la
//      milliseconde près, ce qui arrive dès qu'une machine en poste plusieurs ;
//   2. supprimer un run emporte SA DESCENDANCE. `agent_jobs.parent_job_id`
//      n'est pas une clé étrangère dans la vraie base : rien ne suit un parent
//      supprimé, et ses délégués resteraient orphelins et invisibles.
//
// Les assertions portent sur les LIGNES rendues et sur ce qui reste en base,
// jamais sur des appels comptés (invariant #5).
//
// Mutations vérifiées : la borne `apresLaLigne` remplacée par un `offset` →
// « ne rend ni doublon ni trou » rougit quand un run est inséré entre deux
// pages ; `collectDescendants` retiré de la suppression → « emporte la
// descendance » rougit ; le filtre d'entité retiré des racines → « ne supprime
// pas le run d'un autre espace » rougit.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agents,
  approvalRequests,
  entities,
  eq,
  inArray,
  toolCalls,
  users,
} from '@nodal-agents/db';

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

/**
 * Les runs semés, du plus récent au plus ancien — l'ordre que la liste PROMET :
 * la date décroissante, puis l'identifiant décroissant quand deux runs
 * partagent la date à la milliseconde.
 *
 * Écrit à partir des lignes semées et de la RÈGLE, jamais recopié d'un
 * résultat : un test qui attendrait ce que la requête rend ne prouverait rien.
 */
const attendus: string[] = [];
const semes: { id: string; createdAt: Date | null }[] = [];

function dansLOrdrePromis(rows: readonly { id: string; createdAt: Date | null }[]): string[] {
  return [...rows]
    .sort((a, b) => {
      // Une ligne sans date se range EN DERNIER.
      if (a.createdAt === null && b.createdAt === null) return a.id < b.id ? 1 : -1;
      if (a.createdAt === null) return 1;
      if (b.createdAt === null) return -1;
      const ecart = b.createdAt.getTime() - a.createdAt.getTime();
      if (ecart !== 0) return ecart;
      return a.id < b.id ? 1 : -1;
    })
    .map((r) => r.id);
}
/** Le run qu'on supprimera, et sa chaîne. */
let racineAvecEnfants = '';
let enfant = '';
let petitEnfant = '';
/** Le run d'une AUTRE entité : il ne doit jamais bouger. */
let runVoisin = '';
/** Un run qui TOURNE : la suppression doit le laisser. */
let runVivant = '';

async function semerRun(opts: {
  task: string;
  createdAt: Date | null;
  status?: string;
  parentJobId?: string;
  entityId?: string;
  agentId?: string;
}): Promise<string> {
  const [row] = await testDb
    .insert(agentJobs)
    .values({
      entityId: opts.entityId ?? seed.entityId,
      agentId: opts.agentId ?? seed.agentId,
      channel: 'mcp',
      task: opts.task,
      status: opts.status ?? 'completed',
      conversationId: null,
      parentJobId: opts.parentJobId ?? null,
      createdAt: opts.createdAt,
    })
    .returning({ id: agentJobs.id });
  // Tout run de TÊTE semé ici entre dans l'ordre attendu — sauf ceux d'une
  // autre entité et les délégués, que l'appelant n'y met pas.
  if (opts.parentJobId === undefined && opts.entityId === undefined) {
    semes.push({ id: row!.id, createdAt: opts.createdAt });
  }
  return row!.id;
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  // Le job que `seedMinimal` écrit lui-même est un run de dehors (`api`, sans
  // parent ni conversation) : il fait partie de la liste, et il en est le plus
  // ANCIEN. On le date pour que l'ordre soit le nôtre, pas celui de l'horloge.
  await testDb
    .update(agentJobs)
    .set({ createdAt: new Date('2026-09-01T00:00:00Z') })
    .where(eq(agentJobs.id, seed.jobId));

  // Cinq runs, du plus ancien au plus récent. DEUX partagent la même date à la
  // milliseconde : c'est là qu'un curseur sur la seule date perdrait une ligne.
  const memeInstant = new Date('2026-09-10T12:00:00.000Z');
  semes.push({ id: seed.jobId, createdAt: new Date('2026-09-01T00:00:00Z') });
  await semerRun({ task: 'run 1', createdAt: new Date('2026-09-05T08:00:00Z') });
  await semerRun({ task: 'run 2', createdAt: memeInstant });
  await semerRun({ task: 'run 3', createdAt: memeInstant });
  runVivant = await semerRun({
    task: 'run 4 qui tourne',
    createdAt: new Date('2026-09-15T08:00:00Z'),
    status: 'processing',
  });

  // Le run à supprimer, avec deux niveaux de délégués. Les enfants portent
  // `internal` et aucune conversation : ils ne sont PAS dans la liste, et rien
  // ne les rattacherait à un run une fois leur parent parti.
  racineAvecEnfants = await semerRun({
    task: 'run 5 qui a délégué',
    createdAt: new Date('2026-09-16T08:00:00Z'),
  });
  const [e1] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'internal',
      task: 'le délégué',
      status: 'completed',
      parentJobId: racineAvecEnfants,
    })
    .returning({ id: agentJobs.id });
  enfant = e1!.id;
  const [e2] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'internal',
      task: 'le délégué du délégué',
      status: 'completed',
      parentJobId: enfant,
    })
    .returning({ id: agentJobs.id });
  petitEnfant = e2!.id;

  // Ce qui doit partir AVEC eux : un appel d'outil du petit-enfant (cascade)
  // et une demande en attente du délégué (cascade).
  await testDb.insert(toolCalls).values({
    entityId: seed.entityId,
    jobId: petitEnfant,
    toolName: 'write_file',
    toolInput: { path: 'note.md' },
  });
  await testDb.insert(approvalRequests).values({
    entityId: seed.entityId,
    jobId: enfant,
    agentId: seed.agentId,
    toolName: 'run_command',
    toolInput: { command: 'ls' },
    kind: 'approval',
    status: 'pending',
  });

  // Une AUTRE entité, avec son propre run de dehors. Il est plus RÉCENT que
  // tous les nôtres : s'il fuyait, il serait en tête de la première page.
  const [voisinUser] = await testDb
    .insert(users)
    .values({ email: `voisin-183-${Date.now()}@example.com` })
    .returning({ id: users.id });
  const [voisine] = await testDb
    .insert(entities)
    .values({
      userId: voisinUser!.id,
      name: 'Espace voisin',
      slug: `voisin-183-${Date.now()}`,
    })
    .returning({ id: entities.id });
  const [voisinAgent] = await testDb
    .insert(agents)
    .values({
      entityId: voisine!.id,
      name: 'Agent voisin',
      slug: `agent-voisin-183-${Date.now()}`,
      personality: 'Fixture, jamais exécutée.',
    })
    .returning({ id: agents.id });
  runVoisin = await semerRun({
    task: 'le run du voisin',
    createdAt: new Date('2026-09-17T08:00:00Z'),
    entityId: voisine!.id,
    agentId: voisinAgent!.id,
  });

  attendus.push(...dansLOrdrePromis(semes));
});

async function page(cursor?: string | null) {
  const { listExternalRunsAction } = await import('../conversation-actions.ts');
  const result = await listExternalRunsAction(cursor === undefined ? {} : { cursor });
  if (!result.ok) throw new Error(result.message);
  return result.data;
}

/** Tout ce que la liste rend, page après page, avec le nombre de pages lues. */
async function toutesLesPages(): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | null | undefined = undefined;
  let pages = 0;
  // Un plafond : une borne qui n'avance pas boucle sans fin, et un test qui ne
  // termine pas ne dit rien.
  while (pages < 20) {
    const p: Awaited<ReturnType<typeof page>> = await page(cursor);
    pages += 1;
    ids.push(...p.runs.map((r) => r.id));
    if (p.nextCursor === null) break;
    cursor = p.nextCursor;
  }
  return { ids, pages };
}

describe('la liste du dossier MCP se lit par pages @cap:parler-par-canal-externe/moteur', () => {
  it('rend les runs du plus RÉCENT au plus ancien', async () => {
    const p = await page();
    expect(p.runs.map((r) => r.id)).toEqual(attendus);
    // Aucun délégué : un sous-travail n'est pas un run.
    expect(p.runs.map((r) => r.id)).not.toContain(enfant);
    // Ni le run du voisin : la lecture est bornée à l'entité.
    expect(p.runs.map((r) => r.id)).not.toContain(runVoisin);
  });

  it('ne promet pas de suite quand tout tient sur une page', async () => {
    // Six runs, une page de cinquante : il n'y a rien après, et le curseur le
    // dit — un bouton « Load more » qui rendrait une page vide se lirait comme
    // une panne.
    expect((await page()).nextCursor).toBeNull();
  });

  it('reprend APRÈS la ligne du curseur, sans doublon ni trou', async () => {
    // On rejoue la pagination à la main, une ligne à la fois : c'est la borne
    // qui est en jeu, pas la taille d'une page. Deux des runs partagent la même
    // date à la milliseconde — un curseur sur la seule date en perdrait un.
    const vus: string[] = [];
    let cursor: string | null = null;
    for (const attendu of attendus) {
      const { encodeRunCursor } = await import('../external-runs.ts');
      const suite = await page(cursor);
      const premier = suite.runs[0];
      expect(premier?.id, `la ligne suivante devait être ${attendu}`).toBe(attendu);
      vus.push(premier!.id);
      cursor = encodeRunCursor({ createdAt: premier!.createdAt, id: premier!.id });
    }
    expect(vus).toEqual(attendus);
    expect(new Set(vus).size).toBe(attendus.length);
  });

  it('repart du DÉBUT sur un curseur illisible, plutôt que de rendre une page vide', async () => {
    const p = await page('nimportequoi');
    expect(p.runs.map((r) => r.id)).toEqual(attendus);
  });

  it('parcourt tout le dossier sans jamais revoir la même ligne', async () => {
    const { ids } = await toutesLesPages();
    expect(ids).toEqual(attendus);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('supprimer des runs du dossier MCP @cap:parler-par-canal-externe/moteur', () => {
  it('refuse un run qui TOURNE, et le dit', async () => {
    const { deleteExternalRunsAction } = await import('../conversation-actions.ts');
    const r = await deleteExternalRunsAction([runVivant]);
    if (!r.ok) throw new Error(r.message);
    expect(r.data).toEqual({ deleted: 0, skippedLive: 1 });
    // Il est toujours là.
    const reste = await testDb
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.id, runVivant));
    expect(reste).toHaveLength(1);
  });

  it('ne touche PAS au run d’un autre espace, même nommément', async () => {
    const { deleteExternalRunsAction } = await import('../conversation-actions.ts');
    const r = await deleteExternalRunsAction([runVoisin]);
    if (!r.ok) throw new Error(r.message);
    expect(r.data.deleted).toBe(0);
    const reste = await testDb
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.id, runVoisin));
    expect(reste).toHaveLength(1);
  });

  it('emporte la DESCENDANCE du run, et ce qui pend à elle', async () => {
    const { deleteExternalRunsAction } = await import('../conversation-actions.ts');
    const r = await deleteExternalRunsAction([racineAvecEnfants]);
    if (!r.ok) throw new Error(r.message);
    expect(r.data).toEqual({ deleted: 1, skippedLive: 0 });

    // La racine, son délégué et le délégué de son délégué : plus rien.
    const restants = await testDb
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(inArray(agentJobs.id, [racineAvecEnfants, enfant, petitEnfant]));
    expect(restants).toHaveLength(0);

    // Ce qui cascade est parti avec eux.
    const appels = await testDb
      .select({ id: toolCalls.id })
      .from(toolCalls)
      .where(eq(toolCalls.jobId, petitEnfant));
    expect(appels).toHaveLength(0);
    const demandes = await testDb
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, enfant));
    expect(demandes).toHaveLength(0);
  });

  it('retire la ligne de la liste, et n’emporte aucune autre', async () => {
    const p = await page();
    expect(p.runs.map((r) => r.id)).not.toContain(racineAvecEnfants);
    // Les autres runs sont tous là, dans le même ordre.
    expect(p.runs.map((r) => r.id)).toEqual(attendus.filter((id) => id !== racineAvecEnfants));
  });
});

// ⚠️ CE BLOC SÈME, et il doit donc rester le DERNIER du fichier : les
// cinquante-cinq runs qu'il ajoute passeraient devant ceux des blocs
// précédents, dont l'ordre attendu est écrit ligne à ligne.
describe('deux vraies pages, sans doublon ni trou @cap:parler-par-canal-externe/moteur', () => {
  /** Plus d'une page : c'est le seul moyen de voir la borne travailler. */
  const COMBIEN = 55;
  const enMasse: { id: string; createdAt: Date | null }[] = [];

  beforeAll(async () => {
    // Tous PLUS RÉCENTS que les runs des blocs précédents, à une minute
    // d'intervalle : l'ordre attendu ne dépend alors d'aucun identifiant.
    const depart = new Date('2026-10-01T00:00:00Z').getTime();
    const lignes = Array.from({ length: COMBIEN }, (_, i) => ({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'mcp',
      task: `run en masse ${i}`,
      status: 'completed',
      conversationId: null,
      createdAt: new Date(depart + i * 60_000),
    }));
    const rows = await testDb
      .insert(agentJobs)
      .values(lignes)
      .returning({ id: agentJobs.id, createdAt: agentJobs.createdAt });
    enMasse.push(...rows);
  });

  it('rend une PREMIÈRE page pleine, et promet la suite', async () => {
    const p1 = await page();
    // Cinquante, pas cinquante-cinq : la table ne se lit jamais entière.
    expect(p1.runs).toHaveLength(50);
    expect(p1.nextCursor).not.toBeNull();
    expect(p1.runs.map((r) => r.id)).toEqual(dansLOrdrePromis(enMasse).slice(0, 50));
  });

  it('reprend à la 51e, sans revoir ni sauter une ligne', async () => {
    const p1 = await page();
    const p2 = await page(p1.nextCursor);

    const vus = [...p1.runs, ...p2.runs].map((r) => r.id);
    // Aucun doublon : le curseur est EXCLUSIF.
    expect(new Set(vus).size).toBe(vus.length);
    // Aucun trou : les cinquante-cinq runs de masse sont là, dans l'ordre, et
    // la seconde page enchaîne sur la première.
    expect(vus.slice(0, COMBIEN)).toEqual(dansLOrdrePromis(enMasse));
    // Et la suite du dossier vient après eux, sans avoir été perdue.
    expect(vus).toContain(runVivant);
  });

  it('ne perd rien en parcourant tout le dossier page après page', async () => {
    const { ids, pages } = await toutesLesPages();
    expect(pages).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
    // Tout ce qui existe, une fois : les runs de masse et ceux d'avant, moins
    // celui que le bloc précédent a supprimé.
    const attendusMaintenant = dansLOrdrePromis([
      ...enMasse,
      ...semes.filter((s) => s.id !== racineAvecEnfants),
    ]);
    expect(ids).toEqual(attendusMaintenant);
  });
});

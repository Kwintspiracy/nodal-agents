// @vitest-environment node
/**
 * Ce qu'un parcours de mémoire a le droit d'effacer — la décision ET le DELETE.
 *
 * Le constat (revue de la PR #113, 2e passe) : `memory-kept.spec.ts` effaçait
 * ses lignes dans `afterAll`. Un run tué avant — Ctrl+C, un timeout, un runner
 * qui meurt — les laissait en base pour toujours, et le run suivant n'avait
 * AUCUN garde : personne ne regardait, personne ne le disait.
 *
 * La convention est celle que la PR #118 a introduite pour les identifiants, et
 * pas une seconde : un marqueur qui nomme CE run, lu seulement en suffixe
 * exact, et `NODALAI_E2E_SWEEP_STALE=1` pour réclamer ce qu'un autre run a
 * laissé. Balayer par défaut effacerait les lignes d'un run en cours.
 *
 * Les tests tournent sur un vrai Postgres (pglite), parce qu'une décision juste
 * suivie d'un `where` trop large efface quand même la base de quelqu'un.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { agentMemory, eq } from '@nodal-agents/db';
import {
  applyMemoryCleanup,
  e2eMemoryFact,
  e2eMemoryRunIdOf,
  memoryCleanupOptionsFromEnv,
  planMemoryCleanup,
  selectE2EMemories,
  E2E_MEMORY_RUN_ID,
} from './e2e/memory-cleanup.ts';

const CE_RUN = 'aaaaaa';
const AUTRE_RUN = 'bbbbbb';

describe('e2eMemoryRunIdOf — le marqueur ne se lit qu’en SUFFIXE', () => {
  it('reconnaît le run qui a écrit le fait', () => {
    expect(e2eMemoryRunIdOf(e2eMemoryFact('Quentin plays', CE_RUN))).toBe(CE_RUN);
  });

  it('un fait SANS marqueur n’appartient à aucun run', () => {
    expect(e2eMemoryRunIdOf('Quentin plays the clarinet.')).toBe(null);
  });

  it('un marqueur au MILIEU ne compte pas — c’est quelqu’un qui l’a collé là', () => {
    expect(e2eMemoryRunIdOf(`${e2eMemoryFact('Quentin plays', CE_RUN)} et autre chose`)).toBe(null);
  });

  it('un fait qui ne FINIT pas par le marqueur n’appartient à personne', () => {
    // Le cas exact que `endsWith` attrape et qu'un `includes` laisserait passer :
    // un crochet fermant plus tôt dans la phrase, le marqueur ouvert ensuite, et
    // un dernier caractère quelconque. La tranche lue est alors un identifiant
    // valide en apparence, sur un fait qu'un humain a écrit.
    expect(e2eMemoryRunIdOf(`Voir ] [nodalai-e2e-memory:${CE_RUN}.`)).toBe(null);
  });

  it('un identifiant de run qui n’en est pas un est refusé', () => {
    expect(e2eMemoryRunIdOf('Quentin plays [nodalai-e2e-memory:NOT A RUN ID]')).toBe(null);
  });

  it('le run de ce processus a la forme attendue', () => {
    expect(E2E_MEMORY_RUN_ID).toMatch(/^[a-z0-9]{6,32}$/);
  });
});

describe('planMemoryCleanup — ce qu’on efface, ce qu’on laisse, ce qu’on nomme', () => {
  const LIGNES = [
    { id: 'a-moi', fact: e2eMemoryFact('mine', CE_RUN) },
    { id: 'a-lui', fact: e2eMemoryFact('theirs', AUTRE_RUN) },
    { id: 'humain', fact: 'Quentin prefers concise answers.' },
  ];

  it('par défaut : mes lignes seulement, les autres sont NOMMÉES', () => {
    const plan = planMemoryCleanup(LIGNES, { runId: CE_RUN });
    expect(plan.deleteIds).toEqual(['a-moi']);
    expect(plan.foreign.map((r) => r.id)).toEqual(['a-lui']);
    expect(plan.blocked.map((r) => r.id)).toEqual(['humain']);
  });

  it('avec le balayage demandé : les restes d’un autre run partent aussi', () => {
    const plan = planMemoryCleanup(LIGNES, { runId: CE_RUN, sweepStaleRuns: true });
    expect(plan.deleteIds.sort()).toEqual(['a-lui', 'a-moi']);
    expect(plan.foreign).toEqual([]);
    // Et JAMAIS le fait d'un humain, quelle que soit l'option demandée.
    expect(plan.blocked.map((r) => r.id)).toEqual(['humain']);
  });

  it('le balayage se lit dans la variable de #118, et nulle part ailleurs', () => {
    expect(memoryCleanupOptionsFromEnv({}).sweepStaleRuns).toBe(false);
    expect(memoryCleanupOptionsFromEnv({ NODALAI_E2E_SWEEP_STALE: '1' }).sweepStaleRuns).toBe(true);
    expect(memoryCleanupOptionsFromEnv({ NODALAI_E2E_SWEEP_STALE: 'oui' }).sweepStaleRuns).toBe(
      false,
    );
  });
});

describe('le DELETE qui en sort, sur une vraie base', () => {
  let db: Awaited<ReturnType<typeof spinUpTestDb>>['db'];
  let entityId: string;
  let autreEntite: string;

  beforeAll(async () => {
    const r = await spinUpTestDb();
    db = r.db;
    const seed = await seedMinimal(db);
    entityId = seed.entityId;
    // Une seconde entité, avec un fait portant LE MÊME marqueur : une purge
    // scopée au seul marqueur traverserait les entités.
    const [autre] = await db
      .insert((await import('@nodal-agents/db')).entities)
      .values({ userId: seed.userId, name: 'Autre', slug: `autre-${Date.now()}` })
      .returning({ id: (await import('@nodal-agents/db')).entities.id });
    autreEntite = autre!.id;
    for (const [ent, fact] of [
      [entityId, e2eMemoryFact('mine', CE_RUN)],
      [entityId, e2eMemoryFact('theirs', AUTRE_RUN)],
      [entityId, 'Quentin prefers concise answers.'],
      [autreEntite, e2eMemoryFact('mine', CE_RUN)],
    ] as const) {
      await db.insert(agentMemory).values({ entityId: ent, fact, source: 'manual' });
    }
  });

  const factsDe = async (ent: string) =>
    (
      await db
        .select({ fact: agentMemory.fact })
        .from(agentMemory)
        .where(eq(agentMemory.entityId, ent))
    ).map((r) => r.fact);

  it('ne voit que les lignes MARQUÉES de son entité', async () => {
    const rows = await selectE2EMemories(db, entityId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => e2eMemoryRunIdOf(r.fact) !== null)).toBe(true);
  });

  it('efface ses lignes, garde celle de l’humain et celle de l’autre run', async () => {
    const rows = await selectE2EMemories(db, entityId);
    const plan = planMemoryCleanup(rows, { runId: CE_RUN });
    expect(await applyMemoryCleanup(db, entityId, plan)).toBe(1);

    const restants = await factsDe(entityId);
    expect(restants).toHaveLength(2);
    expect(restants.some((f) => f === 'Quentin prefers concise answers.')).toBe(true);
    expect(restants.some((f) => e2eMemoryRunIdOf(f) === AUTRE_RUN)).toBe(true);
  });

  it('l’entité voisine garde son fait, marqueur identique compris', async () => {
    expect(await factsDe(autreEntite)).toEqual([e2eMemoryFact('mine', CE_RUN)]);
  });

  it('le balayage explicite emporte enfin le reste d’un run interrompu', async () => {
    const rows = await selectE2EMemories(db, entityId);
    const plan = planMemoryCleanup(rows, { runId: CE_RUN, sweepStaleRuns: true });
    expect(await applyMemoryCleanup(db, entityId, plan)).toBe(1);

    const restants = await factsDe(entityId);
    expect(restants).toEqual(['Quentin prefers concise answers.']);
  });
});

// space/reset.ts — `pnpm bench:space reset` : vider la mémoire de l'espace du banc.
//
// Un essai ne doit pas profiter de ce que l'essai précédent a mémorisé : la
// mémoire de l'espace se vide entre deux essais. Seule la mémoire de l'ESPACE
// est visée — l'id vient de l'espace du banc, retrouvé par son slug, jamais
// d'un id reçu de l'appelant. Un souvenir appartient à l'espace par son
// `entity_id`, ou par l'agent qui l'a écrit quand la ligne n'en porte pas.

import type { AnyDrizzleDb } from '@nodal-agents/db';
import { assertSpaceIdle, requireBenchSpace } from './space';

/** Combien de souvenirs l'espace porte ; avec `apply`, les efface. */
export async function resetSpaceMemory(
  db: AnyDrizzleDb,
  opts: { apply: boolean },
): Promise<{ spaceId: string; memories: number; deleted: boolean }> {
  const { agentMemory, agents, count, eq, inArray, or } = await import('@nodal-agents/db');
  const space = await requireBenchSpace(db);
  await assertSpaceIdle(db, space.id);
  const ofSpace = or(
    eq(agentMemory.entityId, space.id),
    inArray(
      agentMemory.agentId,
      db.select({ id: agents.id }).from(agents).where(eq(agents.entityId, space.id)),
    ),
  );
  const [row] = await db.select({ n: count() }).from(agentMemory).where(ofSpace);
  const memories = Number(row?.n ?? 0);
  if (opts.apply && memories > 0) await db.delete(agentMemory).where(ofSpace);
  return { spaceId: space.id, memories, deleted: opts.apply && memories > 0 };
}

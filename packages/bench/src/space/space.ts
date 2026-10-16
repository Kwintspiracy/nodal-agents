// space/space.ts — l'espace du banc : qui il est, d'où il vient, s'il est libre.
//
// Décision du propriétaire (16/10) : le banc des workflows ne tourne JAMAIS sur
// ses agents. Il tourne dans un espace à part, copie de son équipe (mêmes
// prompts, skills et listes d'outils), avec sa PROPRE mémoire, AUCUN canal et
// aucun service qui envoie quoi que ce soit. Le banc y règle le modèle de SES
// copies pour comparer des LLM, jamais celui des agents du propriétaire.
//
// L'espace est une entité dont personne n'est membre : il n'apparaît pas dans
// le tableau de bord, le serveur MCP ne parle pas pour lui sans agent épinglé,
// et la clé LLM semée depuis l'environnement ne le vise pas — la règle de
// `listMemberWorkspaces` (@nodal-agents/db), la même pour tous.
//
// Ses identifiants sont DÉRIVÉS, pas tirés : l'espace est fonction de l'espace
// copié, et chaque copie de sa ligne source. Deux synchronisations écrivent
// les mêmes lignes ; une copie dont la source a disparu se reconnaît ; et un
// espace qui porterait le nom du banc sans venir de cette source est refusé
// au lieu d'être écrasé.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AnyDrizzleDb } from '@nodal-agents/db';

/** Le slug de l'entité du banc — le seul nom que le banc réserve. */
export const BENCH_SPACE_SLUG = 'nodal-bench-space';
export const BENCH_SPACE_NAME = 'Bench space';

/**
 * Le plafond de coût par run posé sur l'espace quand la commande n'en reçoit
 * pas (dollars). Un run du banc qui dépasse est arrêté avec ce qu'il a écrit.
 */
export const DEFAULT_SPACE_MAX_RUN_COST_USD = 1;

/** Un UUID déterministe (forme v5 : SHA-1, version 5, variante RFC 4122). */
export function derivedUuid(namespace: string, name: string): string {
  const h = createHash('sha1').update(`${namespace}\u0000${name}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** L'id de l'espace du banc copié depuis `sourceEntityId`. */
export function spaceIdFor(sourceEntityId: string): string {
  return derivedUuid(BENCH_SPACE_SLUG, sourceEntityId);
}

/** L'id, dans l'espace, de la copie d'une ligne source. */
export function copyIdFor(spaceId: string, table: string, sourceId: string): string {
  return derivedUuid(spaceId, `${table}:${sourceId}`);
}

/** Les statuts d'un job qui n'est pas terminé (même lecture que le banc des workflows). */
const TERMINAL = ['completed', 'failed', 'cancelled'] as const;

/**
 * L'espace du banc tel qu'il est en base, ou null. Ne crée rien.
 */
export async function findBenchSpace(
  db: AnyDrizzleDb,
): Promise<{ id: string; userId: string } | null> {
  const { entities, eq } = await import('@nodal-agents/db');
  const [row] = await db
    .select({ id: entities.id, userId: entities.userId })
    .from(entities)
    .where(eq(entities.slug, BENCH_SPACE_SLUG))
    .limit(1);
  return row ?? null;
}

/** L'espace du banc, ou une erreur qui dit comment le créer. */
export async function requireBenchSpace(db: AnyDrizzleDb): Promise<{ id: string }> {
  const space = await findBenchSpace(db);
  if (!space) {
    throw new Error(
      `bench_space_missing: no workspace "${BENCH_SPACE_SLUG}" yet. ` +
        'Create it with `pnpm bench:space sync --apply`.',
    );
  }
  return space;
}

/**
 * Refuse d'écrire dans l'espace pendant qu'un de ses jobs tourne : changer
 * les agents ou vider la mémoire au milieu d'un essai fausserait l'essai.
 */
export async function assertSpaceIdle(db: AnyDrizzleDb, spaceId: string): Promise<void> {
  const { agentJobs, and, eq, notInArray, or, isNull } = await import('@nodal-agents/db');
  const live = z.array(z.object({ id: z.string() })).parse(
    await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(
        and(
          eq(agentJobs.entityId, spaceId),
          or(isNull(agentJobs.status), notInArray(agentJobs.status, [...TERMINAL])),
        ),
      )
      .limit(5),
  );
  if (live.length > 0) {
    throw new Error(
      `bench_space_busy: ${live.length} job(s) of the bench space are still running ` +
        `(${live.map((j) => j.id).join(', ')}). Wait for them, or cancel them, first.`,
    );
  }
}

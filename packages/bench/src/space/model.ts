// space/model.ts — régler le modèle des agents de l'espace du banc pour UNE série.
//
// C'est la pièce que la couture `ModelApplier` du banc des workflows appellera
// (packages/bench/src/workflows/matrix.ts, PR #756) : avant une série, tous
// les agents de l'espace passent sur le modèle comparé ; après, `restore()`
// leur rend exactement ce qu'ils avaient. Elle ne vise QUE l'espace du banc,
// retrouvé par son slug : aucun id d'entité ne se passe en paramètre, donc
// aucun appel ne peut régler les agents du propriétaire.
//
// Trois choix, dits plutôt que devinés :
//   - la clé : celle de l'espace pour ce fournisseur, et une seule. Aucune, ou
//     plusieurs, et la série refuse en les nommant (invariant #4) ;
//   - la chaîne de repli est VIDÉE pendant la série : un appel servi par un
//     autre modèle mesurerait cet autre modèle, pas celui de la série ;
//   - un agent dont le runtime n'est pas `nodal` (Claude Code, Codex) n'appelle
//     pas `agents.model` : il n'est pas modifié, et le résultat le NOMME, pour
//     que la série dise qu'elle n'est pas pure au lieu de le taire.

import type { AnyDrizzleDb } from '@nodal-agents/db';
import { assertSpaceIdle, requireBenchSpace } from './space';

/** Même forme que `MatrixModel` du banc : `fournisseur` + `modèle`. */
export interface SpaceModel {
  readonly provider: string;
  readonly model: string;
}

export interface AppliedSpaceModel {
  /** Les agents passés sur le modèle (slugs). */
  readonly changed: string[];
  /** Les agents laissés tels quels, et pourquoi. */
  readonly untouched: Array<{ slug: string; reason: string }>;
  /** Rend à chaque agent modifié son modèle, sa clé et sa chaîne de repli. */
  restore(): Promise<void>;
}

export async function applySpaceModel(
  db: AnyDrizzleDb,
  target: SpaceModel,
): Promise<AppliedSpaceModel> {
  const { agents, entityLlmKeys, and, eq } = await import('@nodal-agents/db');
  const space = await requireBenchSpace(db);
  await assertSpaceIdle(db, space.id);

  const keys = await db
    .select({ id: entityLlmKeys.id, nickname: entityLlmKeys.nickname })
    .from(entityLlmKeys)
    .where(
      and(
        eq(entityLlmKeys.entityId, space.id),
        eq(entityLlmKeys.provider, target.provider),
        eq(entityLlmKeys.isActive, true),
      ),
    );
  if (keys.length !== 1) {
    throw new Error(
      `bench_space_model_key: the bench space has ${keys.length} active ${target.provider} key(s)` +
        (keys.length > 1 ? ` (${keys.map((k) => k.nickname ?? k.id).join(', ')})` : '') +
        `; ${target.model} needs exactly one. Sync the space from a team that uses this provider.`,
    );
  }
  const keyId = keys[0]!.id;

  const rows = await db
    .select({
      id: agents.id,
      slug: agents.slug,
      runtime: agents.runtime,
      model: agents.model,
      llmKeyId: agents.llmKeyId,
      fallbackChain: agents.fallbackChain,
    })
    .from(agents)
    .where(eq(agents.entityId, space.id));
  const touched = rows.filter((r) => r.runtime === 'nodal');
  const untouched = rows
    .filter((r) => r.runtime !== 'nodal')
    .map((r) => ({ slug: r.slug, reason: `runtime ${r.runtime} does not use the agent's model` }));
  if (touched.length === 0) {
    throw new Error(
      `bench_space_model_none: no agent of the bench space runs on the nodal runtime; ` +
        `${target.model} would change nothing`,
    );
  }

  await db.transaction(async (tx) => {
    for (const r of touched) {
      await tx
        .update(agents)
        .set({ model: target.model, llmKeyId: keyId, fallbackChain: [], updatedAt: new Date() })
        .where(and(eq(agents.id, r.id), eq(agents.entityId, space.id)));
    }
  });

  let restored = false;
  return {
    changed: touched.map((r) => r.slug),
    untouched,
    async restore() {
      if (restored) return;
      await db.transaction(async (tx) => {
        for (const r of touched) {
          await tx
            .update(agents)
            .set({
              model: r.model,
              llmKeyId: r.llmKeyId,
              fallbackChain: r.fallbackChain,
              updatedAt: new Date(),
            })
            .where(and(eq(agents.id, r.id), eq(agents.entityId, space.id)));
        }
      });
      restored = true;
    },
  };
}

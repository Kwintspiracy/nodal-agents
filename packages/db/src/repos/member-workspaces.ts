// repos/member-workspaces.ts — « l'espace de travail de la personne qui est là »,
// quand une surface locale n'a reçu aucun espace.
//
// Deux surfaces n'ont ni session ni job pour leur dire où écrire : le serveur
// MCP en stdio lancé sans agent épinglé, et la clé LLM que le runner sème
// depuis l'environnement au premier démarrage. Les deux supposaient qu'une
// installation n'a qu'UNE entité, et lisaient « l'unique ligne de `entities` »
// (avec racine, pour le MCP ; tout court, pour la clé).
//
// Ce n'est plus vrai, et ça ne l'était déjà pas : le tableau de bord laisse un
// utilisateur créer plusieurs espaces et passer de l'un à l'autre
// (`createWorkspaceAction`, `switchWorkspaceAction`). Ce qui fait d'une entité
// l'espace de quelqu'un, c'est la même chose partout ailleurs dans la
// plateforme : une ligne `entity_members`. Le sélecteur d'espaces la lit, le
// cookie d'espace actif n'est accepté que contre elle, la connexion locale
// (`LocalAuthProvider.getSession`) en déduit l'espace de la session. Une
// entité dont personne n'est membre n'est l'espace de personne : aucune
// surface locale ne parle pour elle sans qu'on la désigne explicitement (un
// agent épinglé, un id d'entité) — c'est le cas d'un espace d'essai piloté
// par un outil, qui ne s'affiche pas non plus dans le tableau de bord.
//
// Rien n'est choisi au hasard (invariant #4) : zéro ou plusieurs candidats,
// et c'est l'appelant qui refuse en le disant, avec les noms.

import { and, asc, eq, exists, isNotNull, not, sql } from 'drizzle-orm';
import type { AnyDrizzleDb } from '../client.ts';
import { entities, entityMembers } from '../schema/index.ts';

export interface MemberWorkspace {
  id: string;
  name: string;
  rootAgentId: string | null;
}

/** La condition « au moins une personne est membre de cette entité ». */
const hasMember = (db: AnyDrizzleDb) =>
  exists(
    db
      .select({ one: sql`1` })
      .from(entityMembers)
      .where(eq(entityMembers.entityId, entities.id)),
  );

/**
 * Les entités dont au moins une personne est membre, les plus anciennes
 * d'abord (l'ordre ne sert qu'à rendre les messages d'erreur stables : aucun
 * appelant ne doit prendre la première).
 *
 * `withRootAgent` ne garde que celles qui ont un agent racine — ce que le
 * serveur MCP sert par défaut.
 */
export async function listMemberWorkspaces(
  db: AnyDrizzleDb,
  opts: { withRootAgent?: boolean } = {},
): Promise<MemberWorkspace[]> {
  const where = opts.withRootAgent
    ? and(hasMember(db), isNotNull(entities.rootAgentId))
    : hasMember(db);
  return db
    .select({ id: entities.id, name: entities.name, rootAgentId: entities.rootAgentId })
    .from(entities)
    .where(where)
    .orderBy(asc(entities.createdAt), asc(entities.id));
}

/**
 * Combien d'entités SANS membre ont un agent racine — pour qu'un refus dise
 * pourquoi une racine présente en base n'a pas été retenue.
 */
export async function countMemberlessRootWorkspaces(db: AnyDrizzleDb): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(entities)
    .where(and(isNotNull(entities.rootAgentId), not(hasMember(db))));
  return Number(row?.n ?? 0);
}

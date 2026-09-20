'use server';

// sidebar-actions.ts — CE QUE LA BARRE LATÉRALE LIT, et rien de plus (#258).
//
// Les panneaux Agents, Run et Approvals de la planche du propriétaire
// (Figma `WPLtjoJjXJBEqDyCpLy9xc`, nœud `25:1062`) portent quatre listes qui
// n'existent qu'en base. Elles ont déjà leurs actions — `listAgentsAction`,
// `listSchedulesAction`, `listWebhookTriggersAction`, `listApprovalsAction` —
// et aucune ne convient ici, pour deux raisons de fond :
//
//   1. ELLES NE SONT PAS BORNÉES. Trois d'entre elles rendent TOUTE la table
//      de l'entité. La barre en dessine dix lignes, sur chaque page du tableau
//      de bord, toutes les quinze secondes. C'est exactement le constat que la
//      passe 1 de la revue de la PR #206 a posé sur le sous-menu des dossiers.
//   2. ELLES RENDENT TROP. Une ligne d'agent complète porte son jeton de bot
//      Telegram et sa chaîne de repli ; une approbation porte le `tool_input`
//      de l'appel. Rien de tout cela n'est dessiné dans une colonne de 300 px,
//      et tout cela partirait dans le paquet du navigateur.
//
// Chaque action d'ici rend donc UN IDENTIFIANT ET UN NOM — ce que la ligne
// dessine — plus le seul fait dont son point a besoin.
//
// ⚠️ LE PLAFOND EST VALIDÉ, comme toute entrée d'une action serveur (passe 3
// de la revue de la PR #235) : une action est une porte publique, et un
// appelant qui passerait zéro ou dix mille ferait soit une requête absurde,
// soit la lecture non bornée que ce fichier existe pour éviter.

import 'server-only';
import { z } from 'zod';
import { headers } from 'next/headers';
import {
  and,
  desc,
  eq,
  ne,
  agents,
  agentSchedules,
  approvalRequests,
  webhookTriggers,
} from '@nodal-agents/db';
import { requireAuth } from '@nodal-agents/auth';
import { getDb, applyActiveEntity, getAuthProvider } from './server.ts';

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): ActionResult<never> {
  return { ok: false, code, message };
}

async function getSession() {
  const provider = getAuthProvider();
  let req: Request;
  try {
    const h = await headers();
    req = new Request('http://localhost/', { headers: h });
  } catch {
    req = new Request('http://localhost/');
  }
  const session = await requireAuth(req, provider);
  return applyActiveEntity(session, req);
}

/** Le plafond d'une liste de la barre. Jamais zéro, jamais toute la table. */
const SidebarLimit = z.number().int().min(1).max(50);

/** Une ligne de la barre : ce qu'elle dessine, et l'adresse qu'elle ouvre. */
export type SidebarNamedRow = {
  id: string;
  name: string;
};

/**
 * Une ligne d'approbation, telle que les sections APPROVALS et RECENTS la
 * dessinent.
 *
 * Le NOM est celui de l'agent qui demande — c'est ce que la planche écrit sur
 * ses quatre lignes de RECENTS. Quand l'agent a été supprimé depuis, la
 * jointure ne rend rien et la ligne porte le nom de l'OUTIL, qui est le seul
 * fait qui reste ; jamais un nom inventé (invariant #4). Le champ n'est donc
 * jamais vide, et c'est pour cela qu'il n'est pas nullable.
 */
export type SidebarApprovalRow = SidebarNamedRow & {
  /** L'outil dont l'appel est en jeu. L'infobulle de la ligne. */
  toolName: string;
};

// ─── Les agents ───────────────────────────────────────────────────────────────

/**
 * Les agents de l'entité, dans l'ORDRE DE LA PAGE `/agents`.
 *
 * Le même ordre, et pas un autre : la personne range ses agents à la main sur
 * cette page (`position`), et un menu qui les montrerait dans un autre ordre
 * défairait ce rangement sous ses yeux.
 */
export async function listSidebarAgentsAction(
  limit: number,
): Promise<ActionResult<SidebarNamedRow[]>> {
  try {
    const session = await getSession();
    const parsed = SidebarLimit.safeParse(limit);
    if (!parsed.success) return fail('validation_failed', 'Invalid limit');
    const rows = await getDb()
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.entityId, session.entityId))
      .orderBy(agents.position, agents.name, desc(agents.id))
      .limit(parsed.data);
    return ok(rows);
  } catch (err) {
    console.error('[listSidebarAgentsAction]', err);
    return fail('db_error', 'Failed to load agents');
  }
}

// ─── Les tâches planifiées ────────────────────────────────────────────────────

/**
 * Les automatisations à l'horloge, la plus récemment touchée d'abord.
 *
 * Le MÊME ordre que la page des automatisations (`desc(updatedAt)`) : celle
 * qu'on vient de modifier est celle qu'on cherche des yeux.
 */
export async function listSidebarCronAction(
  limit: number,
): Promise<ActionResult<SidebarNamedRow[]>> {
  try {
    const session = await getSession();
    const parsed = SidebarLimit.safeParse(limit);
    if (!parsed.success) return fail('validation_failed', 'Invalid limit');
    const rows = await getDb()
      .select({ id: agentSchedules.id, name: agentSchedules.name })
      .from(agentSchedules)
      .where(eq(agentSchedules.entityId, session.entityId))
      .orderBy(desc(agentSchedules.updatedAt), desc(agentSchedules.id))
      .limit(parsed.data);
    return ok(rows);
  } catch (err) {
    console.error('[listSidebarCronAction]', err);
    return fail('db_error', 'Failed to load schedules');
  }
}

// ─── Les webhooks ─────────────────────────────────────────────────────────────

/** Les déclencheurs HTTP, le plus récemment touché d'abord. */
export async function listSidebarWebhooksAction(
  limit: number,
): Promise<ActionResult<SidebarNamedRow[]>> {
  try {
    const session = await getSession();
    const parsed = SidebarLimit.safeParse(limit);
    if (!parsed.success) return fail('validation_failed', 'Invalid limit');
    const rows = await getDb()
      .select({ id: webhookTriggers.id, name: webhookTriggers.name })
      .from(webhookTriggers)
      .where(eq(webhookTriggers.entityId, session.entityId))
      .orderBy(desc(webhookTriggers.updatedAt), desc(webhookTriggers.id))
      .limit(parsed.data);
    return ok(rows);
  } catch (err) {
    console.error('[listSidebarWebhooksAction]', err);
    return fail('db_error', 'Failed to load webhooks');
  }
}

// ─── Les approbations déjà rendues ────────────────────────────────────────────

/**
 * La section RECENTS du panneau Approvals : ce qui a REÇU une réponse.
 *
 * ⚠️ « RENDUE » SE LIT SUR LA COLONNE, jamais sur une date. `status <>
 * 'pending'` couvre l'approuvé, le refusé ET l'expiré — les trois sont des
 * lignes dont plus personne n'attend rien, et c'est ce que « recents » veut
 * dire à côté d'une section qui, elle, montre l'attente.
 *
 * ⚠️ CE N'EST PAS `listApprovalsAction`. Celle-là rend cent lignes, remonte la
 * chaîne de chaque job, résout le serveur MCP derrière chaque outil et calcule
 * une explication en phrase — de quoi remplir une page, pas quatre lignes d'un
 * menu.
 */
export async function listSidebarRecentApprovalsAction(
  limit: number,
): Promise<ActionResult<SidebarApprovalRow[]>> {
  try {
    const session = await getSession();
    const parsed = SidebarLimit.safeParse(limit);
    if (!parsed.success) return fail('validation_failed', 'Invalid limit');
    const rows = await getDb()
      .select({
        id: approvalRequests.id,
        agentName: agents.name,
        toolName: approvalRequests.toolName,
      })
      .from(approvalRequests)
      .leftJoin(agents, eq(agents.id, approvalRequests.agentId))
      .where(
        and(
          eq(approvalRequests.entityId, session.entityId),
          ne(approvalRequests.status, 'pending'),
        ),
      )
      // Par date de RÉPONSE : c'est l'ordre dans lequel la personne les a
      // rendues, et donc celui dans lequel elle les retrouve.
      .orderBy(desc(approvalRequests.resolvedAt), desc(approvalRequests.id))
      .limit(parsed.data);
    return ok(
      rows.map((r) => ({
        id: r.id,
        // L'agent quand on le connaît, l'outil sinon. Jamais un nom inventé.
        name: r.agentName ?? r.toolName,
        toolName: r.toolName,
      })),
    );
  } catch (err) {
    console.error('[listSidebarRecentApprovalsAction]', err);
    return fail('db_error', 'Failed to load recent approvals');
  }
}

// job-lineage.ts — le job de TÊTE d'une chaîne de délégation.
//
// Un run venu de dehors (`/api/agent`, le serveur MCP) n'a pas de
// conversation. Quand il délègue, l'enfant porte `channel = 'internal'` et
// hérite du `conversation_id` de son parent — donc rien
// (packages/orchestration/src/router/delegate.ts). Lu sur lui-même, ce travail
// ne vient de nulle part : sa question n'était comptée dans aucun dossier, et
// le dossier MCP restait muet pendant qu'un run y attendait une réponse.
//
// La seule chose que la base sait en dire est SA CHAÎNE : `parent_job_id`,
// remonté jusqu'au job que personne n'a délégué. Ce module la remonte, et deux
// faits en sortent : le canal de tête (quel dossier compte le travail) et
// l'identifiant de tête (quelle LIGNE de ce dossier le porte).
//
// ⚠️ Une chaîne incomplète ne se devine pas. Un maillon absent — un parent
// supprimé, une remontée plus longue que le plafond — rend `null`, jamais le
// canal du dernier maillon connu : ce serait présenter une estimation comme un
// fait (invariant #4).

import { agentJobs, and, eq, inArray, type AnyDrizzleDb } from '@nodal-agents/db';

/** Ce qu'il faut savoir d'un job pour remonter sa chaîne. */
export type JobLineageRow = {
  id: string;
  channel: string | null;
  parentJobId: string | null;
};

/** La tête d'une chaîne : `null` partout quand elle n'a pas pu être remontée. */
export type JobRoot = { rootJobId: string | null; rootChannel: string | null };

const INTROUVABLE: JobRoot = { rootJobId: null, rootChannel: null };

/**
 * Le plafond de remontée.
 *
 * L'invariant #8 du dépôt borne la délégation à 3 niveaux
 * (`packages/orchestration/src/chain-counters.ts`) : 8 laisse de la marge pour
 * les chaînes écrites avant ce plafond sans jamais tourner en rond sur une
 * base abîmée.
 */
export const MAX_LINEAGE_HOPS = 8;

/**
 * La tête de la chaîne d'un job, parmi les lignes DÉJÀ lues.
 *
 * Pure : c'est la règle, et elle se teste sans base. Le job cherché doit être
 * dans la carte ; un job de tête est sa propre tête.
 */
export function rootOf(jobId: string, byId: ReadonlyMap<string, JobLineageRow>): JobRoot {
  let current = byId.get(jobId);
  if (current === undefined) return INTROUVABLE;
  const vus = new Set<string>([current.id]);
  for (let saut = 0; saut < MAX_LINEAGE_HOPS; saut += 1) {
    const parentId = current.parentJobId;
    if (parentId === null || parentId === '') {
      return { rootJobId: current.id, rootChannel: current.channel };
    }
    // Un cycle (une base abîmée, un import manuel) ne doit pas boucler : on
    // rend « inconnu », ce qui est vrai, plutôt que de tourner.
    if (vus.has(parentId)) return INTROUVABLE;
    const parent = byId.get(parentId);
    if (parent === undefined) return INTROUVABLE;
    vus.add(parent.id);
    current = parent;
  }
  return INTROUVABLE;
}

/**
 * Les têtes de chaîne des jobs donnés, sur une vraie base.
 *
 * Les lignes de départ sont celles que l'appelant a DÉJÀ lues : un job sans
 * parent n'ajoute aucune requête, et c'est le cas courant. Les ancêtres se
 * lisent par GÉNÉRATION — une requête par niveau, jamais une par job — et la
 * remontée s'arrête dès qu'un niveau n'a plus de parent à chercher.
 *
 * Toujours filtré sur l'entité : un `parent_job_id` qui pointerait ailleurs ne
 * ramène rien, et la chaîne rend « inconnu ».
 */
export async function readJobRoots(
  db: AnyDrizzleDb,
  entityId: string,
  depart: readonly JobLineageRow[],
): Promise<Map<string, JobRoot>> {
  const byId = new Map<string, JobLineageRow>(depart.map((r) => [r.id, r]));

  let aChercher = [...new Set(depart.map((r) => r.parentJobId).filter(nonVide))].filter(
    (id) => !byId.has(id),
  );
  for (let niveau = 0; niveau < MAX_LINEAGE_HOPS && aChercher.length > 0; niveau += 1) {
    const rows = await db
      .select({
        id: agentJobs.id,
        channel: agentJobs.channel,
        parentJobId: agentJobs.parentJobId,
      })
      .from(agentJobs)
      .where(and(eq(agentJobs.entityId, entityId), inArray(agentJobs.id, aChercher)));
    if (rows.length === 0) break;
    for (const r of rows) byId.set(r.id, r);
    aChercher = [...new Set(rows.map((r) => r.parentJobId).filter(nonVide))].filter(
      (id) => !byId.has(id),
    );
  }

  return new Map(depart.map((r) => [r.id, rootOf(r.id, byId)]));
}

function nonVide(id: string | null): id is string {
  return id !== null && id !== '';
}

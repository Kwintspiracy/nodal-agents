'use server';

// workspace-footprint-actions.ts — CE QUE PÈSE UN ESPACE, ET CE QUE COÛTE SON
// FILET (issue #261).
//
// POURQUOI CET ÉCRAN EXISTE. Le filet sous les écritures photographie chaque
// dossier avant le premier outil mutant d'un tour, et son `git add` est borné à
// 30 secondes. Le soir du 19/09/2026, le dossier partagé d'un espace est monté
// à 3,3 Go : la borne a sauté, toute écriture s'est vue refusée, et les agents
// ont cherché une panne du dossier pendant des heures. L'issue #245 a fait dire
// au refus sa cause et ses chiffres. Celle-ci montre la montée AVANT le refus.
//
// DEUX FAITS, et pas un de plus :
//
//   LA TAILLE, comptée par `measureWorkspace` — la MÊME mesure que celle qui
//   chiffre le refus, jamais une seconde. Elle est bornée à 50 000 fichiers et
//   3 secondes, et dit `capped` quand elle s'est arrêtée avant la fin : les
//   deux chiffres sont alors des PLANCHERS, et l'écran écrit « at least ».
//
//   LA DURÉE DE LA DERNIÈRE PHOTO, lue sur `job_checkpoints.snapshot_ms`
//   (migration 0119). C'est elle qu'on regarde monter vers les 30 secondes.
//
// LE DOSSIER PARTAGÉ, ET LUI SEUL. C'est celui que Nodal crée et remplit
// lui-même, donc celui qui grossit sans que personne ne l'ait décidé — c'est
// celui qui a sauté. Les dossiers qu'un agent déclare appartiennent à cet
// agent ; les mesurer tous ferait payer à cet écran trois secondes par dossier
// et par espace, pour des dossiers dont le propriétaire connaît déjà la taille.
// L'écran NOMME donc le dossier qu'il a mesuré, plutôt que de laisser croire
// qu'il pèse tout.
//
// RIEN N'EST ESTIMÉ. Un dossier qui n'existe pas encore, ou qu'on ne peut pas
// lire, ne rend pas « 0 octet » — il rend l'absence, et l'écran la dit
// (invariant #4). Un zéro se lirait « vide », ce qui est un fait, et pas
// « on ne sait pas », qui en est un autre.
//
// ⚠️ CETTE ACTION TRAVAILLE SUR LE DISQUE, et l'écran ne l'attend pas : elle
// est appelée après le montage, comme la liste des fichiers d'un dossier
// d'agent. Trois secondes au pire par espace, jamais payées par le rendu de la
// page des réglages.

import 'server-only';
import { stat } from 'node:fs/promises';
import { agentJobs, desc, entities, entityMembers, eq, jobCheckpoints } from '@nodal-agents/db';
import { formatBytes, measureWorkspace } from '@nodal-agents/checkpoints';
import { requireAuth } from '@nodal-agents/auth';
import { headers } from 'next/headers';
import { getDb, applyActiveEntity, getAuthProvider } from './server.ts';
import { sharedWorkspacePath } from './workspace-roots.ts';

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

/** Ce qu'un comptage a trouvé. `capped` = les deux chiffres sont des planchers. */
export type FootprintMeasure = {
  bytes: number;
  files: number;
  capped: boolean;
  /**
   * Les octets en unité lisible, écrits PAR `formatBytes` — la fonction qui
   * écrit déjà le chiffre de la phrase de refus.
   *
   * Rendue depuis le serveur et non recalculée à l'écran parce que ce module
   * ouvre `node:fs` : importer le formateur dans un composant client ferait
   * entrer le système de fichiers dans le paquet du navigateur. Une seconde
   * fonction d'arrondi, elle, ferait dire deux tailles différentes au même
   * dossier selon l'endroit où on la lit.
   */
  sizeLabel: string;
};

/** La dernière photo de sécurité prise dans cet espace. */
export type LastSnapshot = {
  /**
   * Les millisecondes qu'elle a prises. `null` pour une ligne d'AVANT la
   * colonne : l'écran dit alors « not timed », jamais zéro.
   */
  ms: number | null;
  takenAt: Date;
  /** Le dossier photographié — la photo n'est pas forcément celle du partagé. */
  workspace: string;
};

export type WorkspaceFootprint = {
  workspaceId: string;
  /** Le dossier mesuré, tel qu'il est sur le disque. Nommé par l'écran. */
  path: string;
  /** Le comptage. `null` quand il n'a PAS eu lieu — voir `unmeasured`. */
  measure: FootprintMeasure | null;
  /**
   * Pourquoi le comptage n'a pas eu lieu, quand il n'a pas eu lieu.
   * `absent` : le dossier n'existe pas encore, rien n'y a jamais été écrit.
   * `unreadable` : il existe et le web ne peut pas l'ouvrir.
   * `null` quand la mesure a eu lieu.
   */
  unmeasured: 'absent' | 'unreadable' | null;
  /** `null` = aucun filet n'a encore photographié quoi que ce soit ici. */
  lastSnapshot: LastSnapshot | null;
};

/**
 * Ce que pèse chaque espace dont cette personne est membre, et ce qu'a coûté
 * sa dernière photo de sécurité.
 *
 * Bornée aux espaces de la personne, par la table d'appartenance : la liste
 * des réglages est construite de la même façon (`listWorkspacesAction`), et
 * deux frontières différentes pour la même liste finiraient par diverger.
 */
export async function listWorkspaceFootprintsAction(): Promise<ActionResult<WorkspaceFootprint[]>> {
  try {
    const session = await getSession();
    const db = getDb();

    const mine = await db
      .select({ id: entities.id })
      .from(entityMembers)
      .innerJoin(entities, eq(entities.id, entityMembers.entityId))
      .where(eq(entityMembers.userId, session.userId))
      .orderBy(entities.createdAt);
    if (mine.length === 0) return ok([]);

    const lignes: WorkspaceFootprint[] = [];
    for (const { id } of mine) {
      // LA DERNIÈRE PHOTO DE CET ESPACE, demandée POUR LUI.
      //
      // ⚠️ UNE SEULE LECTURE BORNÉE POUR TOUS LES ESPACES NE MARCHE PAS, et
      // c'est un constat de la revue C de cette PR. Prendre les deux cents
      // lignes les plus récentes toutes entités confondues puis garder la
      // première de chaque espace enterre la photo d'un espace silencieux sous
      // celles d'un espace actif : l'écran écrivait alors « No safety snapshot
      // yet » pour un espace qui en avait une. Une absence AFFIRMÉE à tort est
      // exactement ce que l'invariant #4 refuse, et cette lecture-ci existe
      // pour dire des faits.
      //
      // Une requête par espace, donc — autant que la boucle en fait déjà pour
      // mesurer, et une lecture indexée par `job_id` à côté d'un parcours de
      // disque de trois secondes ne se voit pas.
      const [photo] = await db
        .select({
          ms: jobCheckpoints.snapshotMs,
          takenAt: jobCheckpoints.takenAt,
          workspace: jobCheckpoints.workspace,
        })
        .from(jobCheckpoints)
        .innerJoin(agentJobs, eq(agentJobs.id, jobCheckpoints.jobId))
        .where(eq(agentJobs.entityId, id))
        .orderBy(desc(jobCheckpoints.takenAt))
        // ⚠️ AUCUN TEST NE PROUVE CE `limit`, et c'est assumé : `const [photo]`
        // prendrait de toute façon la première ligne, et l'ordre garantit que
        // c'est la bonne. Il est là pour que la base n'en rende qu'UNE au lieu
        // de tout l'historique d'un espace, ce qu'un test sur le résultat ne
        // peut pas voir (revue C, passe 2, constat 6). L'index
        // `idx_job_checkpoints_taken_at` est ce qui le rend efficace.
        .limit(1);

      const path = sharedWorkspacePath(id);
      let measure: FootprintMeasure | null = null;
      let unmeasured: WorkspaceFootprint['unmeasured'] = null;
      try {
        const st = await stat(path);
        if (!st.isDirectory()) {
          unmeasured = 'unreadable';
        } else {
          // `measureWorkspace` rend `{0, 0, false}` pour un dossier illisible
          // comme pour un dossier vide : c'est le `stat` ci-dessus qui fait la
          // différence, et lui seul.
          const compte = await measureWorkspace(path);
          measure = { ...compte, sizeLabel: formatBytes(compte.bytes) };
        }
      } catch (err) {
        unmeasured = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable';
      }
      lignes.push({
        workspaceId: id,
        path,
        measure,
        unmeasured,
        lastSnapshot:
          photo === undefined
            ? null
            : { ms: photo.ms ?? null, takenAt: photo.takenAt, workspace: photo.workspace },
      });
    }

    return ok(lignes);
  } catch (err) {
    console.error('[listWorkspaceFootprintsAction]', err);
    return fail('db_error', 'Failed to read the workspace sizes');
  }
}

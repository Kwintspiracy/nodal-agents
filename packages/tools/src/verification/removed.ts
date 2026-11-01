// verification/removed.ts — « un appel de ce job a-t-il RETIRÉ ce livrable, et
// l'avait-il déclaré DÉPLACÉ ? », constaté sur le disque autour de l'appel
// (issue #916).
//
// LE DÉFAUT. Toute cible de mutation devient une ligne d'état, et la preuve
// d'un document commence par `exists`. La source d'un `file_move` réussi était
// donc prouvée comme un livrable qui devait exister : « not found », rouge,
// et l'agent devait expliquer à la personne que « la vérification regarde
// l'ancien emplacement ».
//
// LA RÈGLE (forme réduite, décidée le 01/11 après sept passes de revue) : un
// livrable observé retiré par un appel du job est une absence ATTENDUE si, et
// seulement si,
//   1. l'appel avait DÉCLARÉ le déplacement de ce chemin vers une destination
//      (`MutationTarget.movesTo`, une donnée que l'outil porte — jamais un test
//      sur son nom), ET l'outil l'a CONFIRMÉ après l'avoir fait
//      (`ToolContext.confirmMove`), dans un appel qui a rendu son résultat
//      sans lever (revue A de #919, passe 8 : une intention n'est pas un fait,
//      un `rename` qui échoue ne déplace rien) ;
//   2. cette destination retrouve une ligne d'état du MÊME job, par la règle de
//      clé de l'intention (`fileDeliverableKey`) : elle est alors jugée par sa
//      propre preuve, et tout ce qui lui arrive ensuite la fait rougir, elle.
// Tout autre retrait — un `rm`, un `mv` de shell, une copie puis une
// suppression, un déplacement vers un chemin sans clé — garde la preuve de
// main : `exists`, rouge, et la page du run dit qu'il a été retiré par ce run.
//
// CE QUI EST RANGÉ : `removed` (la transition `present -> absent` autour d'un
// appel du job ; `absent -> present` la lève) et `moved_to_key` (la clé de la
// destination déclarée ; la finalisation vérifie qu'elle retrouve une ligne
// du job — la condition 2, jugée à un seul endroit). Aucun contenu n'est
// lu : seule l'existence est la question, et la destination prouve le reste.
//
// CE QUI N'EST PAS VU, et le dit : la sonde ne tourne qu'autour d'un appel qui
// porte des cibles de mutation. Un outil MCP qui efface un fichier sans en
// déclarer n'est pas observé — son fichier reste prouvé par `exists`, rouge.
//
// LE PRIX : une lecture des lignes d'état du job et deux `stat` par livrable,
// pour chaque appel mutant d'un job.
//
// POURQUOI IL NE LÈVE JAMAIS : appelé dans le `finally` qui entoure
// `tool.execute` (`execute.ts`). Une panne ici se DIT par un code et ne pose
// rien — le livrable reste prouvé par `exists`, le sens conservateur.
//
// INVARIANT #2 : tout ce que ce module journalise est un CODE et des données.

import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { jobDeliverableVerificationState, eq } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { MutationTarget } from '@nodal-agents/shared';
import { cheminConstate } from './record-constat';
import { fileDeliverableKey } from './office-file-key';

/** Trois réponses, pas deux : un `stat` refusé ne dit rien de l'existence. */
type Presence = 'present' | 'absent' | 'unknown';

/** L'état d'avant : par ligne d'état, son adresse et ce que la sonde y a vu. */
export type DeliverablePresence = ReadonlyMap<
  string,
  { readonly address: string; readonly presence: Presence }
>;

async function presence(address: string): Promise<Presence> {
  try {
    await stat(address);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    // `ENOTDIR` : un segment du chemin n'est plus un dossier, donc ce chemin
    // n'est plus — la règle d'`observed.ts`.
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown';
  }
}

/**
 * L'adresse d'une ligne sur le disque : son chemin d'affichage, sa clé à
 * défaut — la même règle que la preuve (`document.ts`, `loadConfig`). Une
 * adresse qui n'est pas un chemin absolu n'est pas sondée : relative, elle
 * serait résolue contre le dossier du runner, et désignerait autre chose.
 */
function addressOf(row: {
  displayPathSnapshot: string | null;
  canonicalKey: string;
}): string | null {
  const address = row.displayPathSnapshot ?? row.canonicalKey;
  return isAbsolute(address) ? address : null;
}

/** La sonde d'AVANT l'appel : chaque livrable du job, présent ou absent. */
export async function probeJobDeliverables(
  db: AnyDrizzleDb,
  jobId: string | undefined,
): Promise<DeliverablePresence> {
  const out = new Map<string, { address: string; presence: Presence }>();
  if (!jobId) return out;
  try {
    const rows = await db
      .select({
        id: jobDeliverableVerificationState.id,
        canonicalKey: jobDeliverableVerificationState.canonicalKey,
        displayPathSnapshot: jobDeliverableVerificationState.displayPathSnapshot,
      })
      .from(jobDeliverableVerificationState)
      .where(eq(jobDeliverableVerificationState.jobId, jobId));
    for (const row of rows) {
      const address = addressOf(row);
      if (address === null) continue;
      out.set(row.id, { address, presence: await presence(address) });
    }
  } catch (err) {
    console.error(
      `[verification] VERIFICATION_REMOVAL_PROBE_FAILED job=${jobId} ` +
        `error=${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return out;
}

/** Ce que l'appel a déclaré, pour juger un retrait. */
export interface RemovalContext {
  /** Les cibles de mutation de l'appel — celles qui portent `movesTo` (l'intention). */
  readonly targets: readonly MutationTarget[];
  /**
   * Les déplacements que l'outil a CONFIRMÉS après les avoir faits, source →
   * destination (`ToolContext.confirmMove`) — vide quand l'appel a levé (le
   * fait). Sans confirmation, une intention n'est rien (revue A, passe 8).
   */
  readonly deplacementsFaits: ReadonlyMap<string, string>;
  /** Les racines des dossiers du job : la règle de clé de l'intention. */
  readonly workspaceRoots: readonly string[];
}

/**
 * La clé de la destination où l'appel a DÉCLARÉ déplacer `address`, par la
 * règle de clé de l'intention (`fileDeliverableKey`) ; `null` si l'appel n'a
 * rien déclaré pour ce chemin, ou si la destination n'a pas de clé (hors des
 * racines). Que cette clé retrouve une ligne d'état du job se juge à la
 * finalisation, à UN seul endroit (`finalize.ts`), sur les lignes qu'elle lit.
 *
 * Les chemins sont comparés RÉELS (`cheminConstate`) : la cible porte le
 * chemin résolu par l'outil, la ligne d'état son chemin d'affichage rebasé sur
 * la racine lexicale — la même adresse, deux orthographes sous un nom court 8.3
 * ou une jonction (le rouge de la CI Windows sur 182c2c39).
 */
async function destinationDeclaree(address: string, ctx: RemovalContext): Promise<string | null> {
  const ici = await cheminConstate(address);
  for (const t of ctx.targets) {
    if (t.kind !== 'file' || t.movesTo === undefined) continue;
    if ((await cheminConstate(t.path)) !== ici) continue;
    // L'intention ne vaut fait que si l'outil a confirmé CE déplacement-là.
    const fait = ctx.deplacementsFaits.get(t.path);
    if (fait === undefined || (await cheminConstate(fait)) !== (await cheminConstate(t.movesTo))) {
      return null;
    }
    return fileDeliverableKey(t.movesTo, ctx.workspaceRoots, 'document');
  }
  return null;
}

/**
 * La sonde d'APRÈS, et ce qu'elle range : `removed = true` sur chaque livrable
 * passé de présent à absent pendant l'appel, avec `moved_to_key` quand l'appel
 * l'avait déclaré déplacé vers un livrable du job ; `removed = false`, sans
 * destination, sur chaque livrable revenu. Une adresse inconnue d'un côté ou de
 * l'autre ne pose rien.
 *
 * Rend les identifiants des lignes réellement marquées retirées — ce qui rend
 * la règle observable en test plutôt que muette.
 */
export async function recordObservedRemovals(
  db: AnyDrizzleDb,
  jobId: string | undefined,
  before: DeliverablePresence,
  ctx: RemovalContext,
): Promise<readonly string[]> {
  if (!jobId || before.size === 0) return [];
  const marques: string[] = [];
  for (const [id, { address, presence: avant }] of before) {
    try {
      const apres = await presence(address);
      let set: { removed: boolean; movedToKey: string | null } | null = null;
      if (avant === 'present' && apres === 'absent') {
        set = { removed: true, movedToKey: await destinationDeclaree(address, ctx) };
      } else if (avant === 'absent' && apres === 'present') {
        set = { removed: false, movedToKey: null };
      }
      if (set === null) continue;
      const rows = await db
        .update(jobDeliverableVerificationState)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(jobDeliverableVerificationState.id, id))
        .returning({ id: jobDeliverableVerificationState.id });
      if (set.removed) marques.push(...rows.map((r) => r.id));
    } catch (err) {
      console.error(
        `[verification] VERIFICATION_REMOVAL_MARK_FAILED job=${jobId} row=${id} ` +
          `error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return marques;
}

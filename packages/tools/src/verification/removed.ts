// verification/removed.ts — « un appel de ce job a-t-il RETIRÉ ce livrable ? »,
// constaté sur le disque autour de l'appel (issue #916).
//
// LE DÉFAUT. Toute cible de mutation devient une ligne d'état, et la preuve
// d'un document commence par `exists`. Ce que le job a RETIRÉ — la source d'un
// `file_move`, un fichier qu'un `run_command` efface, un projet qu'il supprime —
// était donc prouvé comme ce qu'il devait avoir PRODUIT : un déplacement réussi
// finissait rouge sur « not found », et l'agent devait expliquer à la personne
// que « la vérification regarde l'ancien emplacement ».
//
// LA RÈGLE, la même pour tout outil et tout type de livrable : l'ADRESSE de
// chaque livrable du job (`display_path_snapshot`, la clé à défaut — la règle
// de la preuve) est sondée avant l'appel et après. `present -> absent` pose
// `removed`, `absent -> present` le lève. Rien d'autre :
//
//   - un fichier qui disparaît ENTRE deux appels du job (une autre personne, un
//     autre processus) n'est vu par aucune sonde : `removed` reste faux et sa
//     preuve reste `exists`, donc rouge. C'est le rouge qui compte, gardé ;
//   - l'outil n'a rien à déclarer : un shell n'a pas à dire ce qu'il efface,
//     un outil de suppression futur n'a pas de crochet à porter. Les livrables
//     qu'un appel visait SANS les connaître (un `rm` dans le `cwd` d'un
//     `run_command`) sont sondés parce qu'ils sont des livrables du job, pas
//     parce que l'appel les a nommés.
//
// CE QUI N'EST PAS VU, et le dit : la sonde ne tourne qu'autour d'un appel qui
// porte des cibles de mutation (le même périmètre que l'empreinte des fichiers,
// `observed.ts`). Un outil MCP qui efface un fichier sans en déclarer n'est pas
// observé — son fichier, s'il était un livrable, reste prouvé par `exists`.
// Et une fenêtre reste : un autre processus qui efface un livrable PENDANT un
// appel du job est attribué au job. La sonde constate une transition autour de
// l'appel ; elle ne sait pas qui a tenu la gomme.
//
// LE PRIX : une lecture des lignes d'état du job et deux `stat` par livrable,
// pour chaque appel mutant d'un job. Les livrables d'un job se comptent sur les
// doigts ; aucun contenu n'est lu — seule l'existence est la question.
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

/**
 * Trois réponses, pas deux : un `stat` refusé ne dit rien de l'existence. La
 * TAILLE vue avant l'appel est gardée (revue A de #919, passe 3) : rangée avec
 * le retrait (`removed_size`), elle borne ce que la finalisation acceptera de
 * lire pour retrouver le contenu ailleurs — un fichier d'une autre taille ne
 * peut pas porter ces octets-là.
 */
type Presence =
  | { readonly kind: 'present'; readonly size: number }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown' };

/** L'état d'avant : par ligne d'état, son adresse et ce que la sonde y a vu. */
export type DeliverablePresence = ReadonlyMap<
  string,
  { readonly address: string; readonly presence: Presence }
>;

async function presence(address: string): Promise<Presence> {
  try {
    const s = await stat(address);
    return { kind: 'present', size: s.size };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    // `ENOTDIR` : un segment du chemin n'est plus un dossier, donc ce chemin
    // n'est plus — la règle d'`observed.ts`.
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'absent' } : { kind: 'unknown' };
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

/**
 * La sonde d'APRÈS, et ce qu'elle range : `removed = true` et la taille vue
 * avant (`removed_size`) sur chaque livrable passé de présent à absent pendant
 * l'appel ; `removed = false`, sans taille, sur chaque livrable revenu. Une
 * adresse inconnue d'un côté ou de l'autre ne pose rien.
 *
 * Rend les identifiants des lignes réellement marquées retirées — ce qui rend
 * la règle observable en test plutôt que muette.
 */
export async function recordObservedRemovals(
  db: AnyDrizzleDb,
  jobId: string | undefined,
  before: DeliverablePresence,
): Promise<readonly string[]> {
  if (!jobId || before.size === 0) return [];
  const marques: string[] = [];
  for (const [id, { address, presence: avant }] of before) {
    const apres = await presence(address);
    let set: { removed: boolean; removedSize: number | null } | null = null;
    if (avant.kind === 'present' && apres.kind === 'absent') {
      set = { removed: true, removedSize: avant.size };
    } else if (avant.kind === 'absent' && apres.kind === 'present') {
      set = { removed: false, removedSize: null };
    }
    if (set === null) continue;
    try {
      // Une ligne par livrable : chacun porte SA taille.
      const rows = await db
        .update(jobDeliverableVerificationState)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(jobDeliverableVerificationState.id, id))
        .returning({ id: jobDeliverableVerificationState.id });
      if (set.removed) marques.push(...rows.map((r) => r.id));
    } catch (err) {
      console.error(
        `[verification] VERIFICATION_REMOVAL_MARK_FAILED job=${jobId} removed=${set.removed} ` +
          `error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return marques;
}

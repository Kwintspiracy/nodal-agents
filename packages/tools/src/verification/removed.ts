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
// pour chaque appel mutant d'un job. L'EMPREINTE d'avant (ce qui sera retiré,
// revue A de #919, passe 6) est gratuite pour une cible nommée — l'instantané
// du seam l'a prise ; pour les autres livrables, seul un appel qui vise un
// dossier les fait hacher, dans `REMOVAL_PROBE_MAX_BYTES` par appel.
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
import { fingerprint, type FileFingerprint, type FileSnapshot } from './observed';
import { cheminConstate } from './record-constat';

/**
 * Ce que la sonde d'avant accepte de hacher, par appel, pour les livrables que
 * l'appel ne NOMME pas (revue A de #919, passe 6).
 *
 * L'identité de ce qu'un appel retire se prend AU MOMENT DU RETRAIT : juste
 * avant l'appel, sur le disque. Pour une cible nommée (la source d'un
 * `file_move`), l'instantané du seam l'a déjà prise : gratuit. Un livrable que
 * l'appel ne nomme pas ne peut être retiré que par un appel qui vise un
 * DOSSIER (un shell, un harnais) : seuls ceux-là le font hacher, et dans cette
 * borne. 64 Mio se lisent en une fraction de seconde ; au-delà, l'identité
 * reste inconnue — un retrait en sera rouge, et le dira à la finalisation
 * (`VERIFICATION_RESCUE_IDENTITY_UNKNOWN`).
 */
export const REMOVAL_PROBE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Trois réponses, pas deux : un `stat` refusé ne dit rien de l'existence. La
 * TAILLE et l'EMPREINTE vues avant l'appel sont gardées : rangées avec le
 * retrait (`removed_size`, `removed_sha256`), elles disent QUEL contenu a été
 * retiré. `sha256` est `null` quand elle n'a pas été prise (hors borne, un
 * dossier, une lecture refusée).
 */
type Presence =
  | { readonly kind: 'present'; readonly size: number; readonly sha256: string | null }
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
    return { kind: 'present', size: s.size, sha256: null };
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

/** Ce que la sonde d'avant sait déjà, et ce qu'elle a le droit de lire. */
export interface RemovalProbeOptions {
  /** L'instantané des cibles NOMMÉES de l'appel, déjà pris par le seam. */
  readonly connues: FileSnapshot;
  /** L'appel vise-t-il un dossier ? Seul un tel appel retire ce qu'il ne nomme pas. */
  readonly hacherLesAutres: boolean;
  /** Le plafond d'octets hachés pour les livrables non nommés. */
  readonly maxBytes: number;
}

/** La sonde d'AVANT l'appel : chaque livrable du job, présent ou absent, et son contenu. */
export async function probeJobDeliverables(
  db: AnyDrizzleDb,
  jobId: string | undefined,
  options: RemovalProbeOptions,
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
    let budget = options.maxBytes;
    // L'instantané est rangé sous le chemin RÉEL de la cible, la ligne d'état
    // sous son chemin d'affichage, rebasé sur la racine lexicale : la même
    // adresse, deux orthographes (un nom court 8.3 sous Windows, une jonction).
    // Les deux sont ramenées au chemin réel, la règle de `cheminConstate`.
    const connues = new Map<string, FileFingerprint>();
    for (const [chemin, f] of options.connues) connues.set(await cheminConstate(chemin), f);
    for (const row of rows) {
      const address = addressOf(row);
      if (address === null) continue;
      let p = await presence(address);
      if (p.kind === 'present') {
        const connue = connues.get(await cheminConstate(address));
        if (connue?.kind === 'file') {
          p = { ...p, sha256: connue.sha256 };
        } else if (options.hacherLesAutres && p.size <= budget) {
          const f = await fingerprint(address);
          if (f.kind === 'file') {
            budget -= p.size;
            p = { ...p, sha256: f.sha256 };
          }
        }
      }
      out.set(row.id, { address, presence: p });
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
 * La sonde d'APRÈS, et ce qu'elle range : `removed = true`, la taille et
 * l'empreinte vues avant (`removed_size`, `removed_sha256`) sur chaque
 * livrable passé de présent à absent pendant l'appel ; `removed = false`, sans
 * taille ni empreinte, sur chaque livrable revenu. Une adresse inconnue d'un
 * côté ou de l'autre ne pose rien.
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
    let set: {
      removed: boolean;
      removedSize: number | null;
      removedSha256: string | null;
    } | null = null;
    if (avant.kind === 'present' && apres.kind === 'absent') {
      set = { removed: true, removedSize: avant.size, removedSha256: avant.sha256 };
    } else if (avant.kind === 'absent' && apres.kind === 'present') {
      set = { removed: false, removedSize: null, removedSha256: null };
    }
    if (set === null) continue;
    try {
      // Une ligne par livrable : chacun porte SA taille et SON empreinte.
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

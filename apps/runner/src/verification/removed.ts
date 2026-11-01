// verification/removed.ts — la preuve d'un livrable que le job a RETIRÉ (#916).
//
// Le seam d'exécution pose `removed` sur une ligne d'état quand l'adresse du
// livrable était là avant un appel du job et n'y est plus après
// (`packages/tools/src/verification/removed.ts`). Ce qui se prouve alors n'est
// plus « il existe, il est bien formé » — c'est faux par construction — mais
// « il est toujours absent » : un seul constat, `absent`.
//
// POURQUOI UN CONSTAT, ET PAS UNE LIGNE QUI SORT DE LA PREUVE. Sortir le
// livrable de l'ensemble prouvé aurait fait disparaître le fait de la page du
// run, et le retrait n'aurait plus été dit nulle part. Le constat garde les
// deux : la page montre la séquence (`absent:removed-by-this-run`, verte), et un
// fichier qui REVIENT après que le job l'a retiré rougit — ce n'est plus ce que
// le job a laissé.
//
// LE MÊME POUR TOUT TYPE. Le vérificateur du type est enveloppé, jamais
// remplacé dans le registre : un document, un classeur ou un projet retirés
// sont prouvés par la même absence, et la primitive terminale n'apprend aucun
// nom de type (T13(c)).
//
// LE CONSTAT N'A PAS DE POUVOIR : il ne lance rien, il fait un `stat`.
//
// L'ABSENCE N'EST VERTE QUE SI AUCUN TRAVAIL DU JOB N'EST PERDU (revue A de la
// PR #919, passe 1). « Le job l'a retiré » ne suffit pas : un `file_write
// rapport.md` suivi d'un `run_command` de nettoyage qui l'efface finissait vert
// sur l'absence, sans réparation, rapport perdu — là où main le rendait rouge
// et rouvrait le run.
//
// QUEL CONTENU A ÉTÉ RETIRÉ : PRIS AU MOMENT DU RETRAIT (revue A, passe 6).
// Les passes 1 à 5 le reconstruisaient depuis l'HISTORIQUE des constats, et cet
// historique est réécrit par tour (une ligne par (job, tour, chemin), #227) :
// chaque passe y a trouvé un trou de plus. La sonde d'avant l'appel range
// l'empreinte de ce qu'elle voit avec le retrait (`removed_sha256`, à côté de
// `removed_size`) : l'instantané du seam pour une cible nommée, une lecture
// bornée pour ce qu'un appel qui vise un dossier peut effacer sans le nommer
// (`packages/tools/src/verification/removed.ts`). Le sauvetage n'a plus ni
// chaîne à suivre, ni tour à rapprocher, ni `renamed_from`, ni « dernière
// écriture » à chercher. Trois cas, sans rien savoir d'un outil ni d'un type :
//
//   a. aucune ligne de constat du job, hors tour de la plateforme, ne porte
//      cette identité (`content_sha256` ou `observed_sha256`) : le job n'a
//      jamais écrit ce contenu — il a retiré un fichier qu'il n'a pas produit
//      (la forme de #916). Absence verte ;
//   b. une ligne de constat du job, à un AUTRE chemin, porte cette identité, et
//      le contenu réel de ce chemin, haché, l'égale encore : il a été déplacé
//      ou copié. Absence verte ;
//   c. sinon : la preuve du type, donc `exists`, donc rouge — comme sur main,
//      réparation comprise. Un fichier temporaire que le job crée puis efface
//      est rouge, comme sur main : c'est la conséquence de la règle.
//
// Et quand la sonde n'a pas pu prendre l'empreinte (hors borne, un dossier,
// une lecture refusée) : rouge, et c'est dit
// (`VERIFICATION_RESCUE_IDENTITY_UNKNOWN`). Jamais deviné.
//
// LE TOUR DE LA PLATEFORME (`PLATFORM_WRITE_TURN`, un fichier reçu, #918) ne
// compte pas comme une écriture du job au cas a : c'est la copie d'un message
// que la personne a encore dans son canal ; l'effacer à sa demande n'est pas
// perdre ce que le run a produit. Un fichier reçu que le job DÉPLACE porte en
// revanche son identité sur la ligne du déplacement (l'empreinte d'après de la
// destination) : s'il est ensuite effacé partout, ce contenu-là est perdu par
// le run, et la source comme la destination sont rouges.
//
// LE FILTRE DE TAILLE. Un candidat n'est lu que si son `stat` rend la taille
// vue au retrait (`removed_size`) : un fichier changé depuis son constat n'est
// pas lu pour rien.
//
// LE PLAFOND. Ce qu'une finalisation hache est borné : `RESCUE_LIMITS`, en
// fichiers et en octets, cumulés sur toutes les lignes retirées, décidé AVANT
// de lire. Au-delà, la ligne garde son rouge et c'est dit
// (`VERIFICATION_RESCUE_CAP_REACHED`). Une lecture qui échoue se DIT
// (`VERIFICATION_RESCUE_UNREADABLE`) et ne sauve rien.
//
// LA BORNE, pour une finalisation : aucune ligne retirée non promise, un
// `select` ; sinon un `select` des constats du job, un `stat` par chemin
// candidat distinct, et au plus `maxFiles` lectures et `maxBytes` octets — chaque
// lecture sur un fichier dont un constat du job a dit qu'il portait exactement
// ce contenu, et qui a encore sa taille.
//
// HORS DU VERROU : `rescuedRemovals` tourne AVANT la transaction 1 de la
// finalisation, qui ne fait que relire sa réponse. Voir `finalize.ts` pour ce
// qui garde la réponse juste entre les deux.

import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { and, constatedWrites, eq, jobDeliverableVerificationState } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { PLATFORM_WRITE_TURN, cheminConstate } from '@nodal-agents/tools';
import type {
  DeliverableVerifier,
  LoadedConfig,
  OnCommandDone,
  ProofCommandRecord,
  ProofResult,
  ReadyConfig,
  VerifierTarget,
} from './types.ts';

/** Le nom du constat, tel que la page du run l'affiche. Un code, pas une phrase. */
export const REMOVED_PROOF_COMMAND = 'absent:removed-by-this-run';

/** Le préfixe du manifeste : change si la règle change, comme `DOCUMENT_MANIFEST_HASH`. */
const REMOVED_MANIFEST = 'removed-v1';

type Presence = 'absent' | 'present' | 'unknown';

async function presence(path: string): Promise<{ presence: Presence; code?: string }> {
  try {
    await stat(path);
    return { presence: 'present' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { presence: 'absent' };
    return { presence: 'unknown', code: code ?? 'UNKNOWN' };
  }
}

/**
 * Le vérificateur d'un livrable retiré : celui du type pour son identité
 * (`deliverableType`, `canonicalize`), l'absence pour sa preuve.
 */
export function removedDeliverableVerifier(base: DeliverableVerifier): DeliverableVerifier {
  return {
    deliverableType: base.deliverableType,
    canonicalize: (raw) => base.canonicalize(raw),

    // L'adresse est la règle de la preuve d'un document (constat C2) : le
    // chemin d'affichage, la clé à défaut. L'état de l'adresse entre dans le
    // manifeste : un fichier qui revient pendant la preuve la rend périmée.
    async loadConfig(_tx, target: VerifierTarget): Promise<LoadedConfig> {
      const path = target.displayPath ?? target.canonicalKey;
      return {
        kind: 'ready',
        manifestHash: `${REMOVED_MANIFEST}:${(await presence(path)).presence}`,
        cwd: path,
        subject: path,
        commands: [],
        epoch: 0,
      };
    },

    async runProof(config: ReadyConfig, onCommandDone: OnCommandDone): Promise<ProofResult> {
      const path = config.subject;
      if (path === undefined) throw new Error(`REMOVED_CONFIG_WITHOUT_SUBJECT: ${config.cwd}`);
      const t0 = Date.now();
      const seen = await presence(path);
      const record: ProofCommandRecord = {
        rank: 1,
        command: REMOVED_PROOF_COMMAND,
        outcomeKind: 'exit',
        exitCode: seen.presence === 'absent' ? 0 : 1,
        stdoutTail: seen.presence === 'absent' ? `${path} removed by a call of this run` : '',
        stderrTail:
          seen.presence === 'present'
            ? `${path} exists again: a call of this run removed it`
            : seen.presence === 'unknown'
              ? `${path} could not be checked (${seen.code})`
              : '',
        durationMs: Date.now() - t0,
        verdict: seen.presence === 'absent' ? 'green' : 'red',
      };
      try {
        await onCommandDone(record);
      } catch (error) {
        console.warn(
          `[verification] REMOVED_RECORD_CALLBACK_FAILED ` +
            `error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {
        verdict: record.verdict,
        records: [record],
        provedManifestHash: `${REMOVED_MANIFEST}:${seen.presence}`,
      };
    },
  };
}

/**
 * Ce qu'une finalisation accepte de hacher pour retrouver un contenu retiré.
 *
 * Les valeurs : un candidat a la taille EXACTE du contenu retiré, donc le
 * plafond d'octets borne surtout le cas d'un gros fichier déplacé. 256 Mio se
 * hachent en une à deux secondes sur un disque ordinaire — l'attente qu'on
 * accepte d'ajouter à la fin d'un run ; au-delà, la ligne garde son rouge et
 * le run se répare plutôt que de faire attendre la personne. 8 fichiers : un
 * contenu retiré n'a, en pratique, qu'une ou deux copies vivantes ; plus de
 * huit fichiers de la même taille exacte dans la chaîne n'est plus une
 * recherche, c'est un balayage.
 */
export interface RescueLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
}
export const RESCUE_LIMITS: RescueLimits = { maxFiles: 8, maxBytes: 256 * 1024 * 1024 };

/** L'empreinte d'un candidat, lue en flux : `null` quand la lecture échoue (dit). */
async function empreinteCandidat(path: string): Promise<string | null> {
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code ?? 'UNKNOWN';
    console.warn(`[verification] VERIFICATION_RESCUE_UNREADABLE path=${path} code=${code}`);
    return null;
  }
}

/** La taille d'un candidat s'il est un fichier là, `null` sinon. Sans lire. */
async function tailleCandidat(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

/**
 * Les lignes retirées du job dont AUCUN travail n'est perdu (cas a et b de
 * l'en-tête), avec la génération sale à laquelle la réponse a été prise.
 *
 * Appelée hors transaction, avant le verrou du job. Une ligne absente de la
 * réponse garde la preuve de son type — le sens prudent.
 */
export async function rescuedRemovals(
  db: AnyDrizzleDb,
  jobId: string,
  limits: RescueLimits = RESCUE_LIMITS,
): Promise<ReadonlyMap<string, number>> {
  const out = new Map<string, number>();
  const retirees = await db
    .select({
      id: jobDeliverableVerificationState.id,
      canonicalKey: jobDeliverableVerificationState.canonicalKey,
      displayPathSnapshot: jobDeliverableVerificationState.displayPathSnapshot,
      dirtyGeneration: jobDeliverableVerificationState.dirtyGeneration,
      removedSize: jobDeliverableVerificationState.removedSize,
      removedSha256: jobDeliverableVerificationState.removedSha256,
    })
    .from(jobDeliverableVerificationState)
    .where(
      and(
        eq(jobDeliverableVerificationState.jobId, jobId),
        eq(jobDeliverableVerificationState.removed, true),
        eq(jobDeliverableVerificationState.declared, false),
      ),
    );
  if (retirees.length === 0) return out;

  const ecritures = await db
    .select({
      path: constatedWrites.path,
      turn: constatedWrites.turn,
      sha: constatedWrites.contentSha256,
      observed: constatedWrites.observedSha256,
    })
    .from(constatedWrites)
    .where(eq(constatedWrites.jobId, jobId));

  // Un `stat` et au plus une lecture par chemin, toutes lignes confondues ; le
  // budget de la finalisation, consommé par chaque lecture faite.
  const tailles = new Map<string, Promise<number | null>>();
  const taille = (path: string): Promise<number | null> => {
    let p = tailles.get(path);
    if (!p) {
      p = tailleCandidat(path);
      tailles.set(path, p);
    }
    return p;
  };
  const lues = new Map<string, string | null>();
  let fichiersLus = 0;
  let octetsLus = 0;

  for (const row of retirees) {
    if (row.dirtyGeneration === null) continue;
    const retire = row.removedSha256;
    if (retire === null) {
      console.warn(
        `[verification] VERIFICATION_RESCUE_IDENTITY_UNKNOWN job=${jobId} row=${row.id} ` +
          `reason=no_sha_at_removal`,
      );
      continue;
    }
    const address = row.displayPathSnapshot ?? row.canonicalKey;
    const ici = isAbsolute(address) ? await cheminConstate(address) : address;
    const porteurs = ecritures.filter(
      (e) => e.turn !== PLATFORM_WRITE_TURN && (e.sha === retire || e.observed === retire),
    );
    // Cas a : le job n'a jamais écrit ce contenu.
    if (porteurs.length === 0) {
      out.set(row.id, row.dirtyGeneration);
      continue;
    }

    // Cas b : les AUTRES chemins où un constat du job a vu ce contenu, qui ont
    // encore la taille du contenu retiré — sans rien lire.
    const aLire: { path: string; size: number }[] = [];
    for (const c of new Set(porteurs.map((e) => e.path))) {
      if (c === ici) continue;
      const size = await taille(c);
      if (size === null) continue;
      if (row.removedSize !== null && size !== row.removedSize) continue;
      aLire.push({ path: c, size });
    }
    // Le plafond, décidé AVANT de lire.
    const neufs = aLire.filter((c) => !lues.has(c.path));
    const fichiers = fichiersLus + neufs.length;
    const octets = octetsLus + neufs.reduce((n, c) => n + c.size, 0);
    if (fichiers > limits.maxFiles || octets > limits.maxBytes) {
      console.warn(
        `[verification] VERIFICATION_RESCUE_CAP_REACHED job=${jobId} row=${row.id} ` +
          `files=${fichiers} bytes=${octets} maxFiles=${limits.maxFiles} maxBytes=${limits.maxBytes}`,
      );
      continue;
    }
    for (const c of aLire) {
      if (!lues.has(c.path)) {
        lues.set(c.path, await empreinteCandidat(c.path));
        fichiersLus += 1;
        octetsLus += c.size;
      }
      if (lues.get(c.path) === retire) {
        out.set(row.id, row.dirtyGeneration);
        break;
      }
    }
  }
  return out;
}

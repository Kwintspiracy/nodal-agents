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
// et rouvrait le run. Les lignes non promises sont le filet de #509 pour ce
// que les outils de fichiers écrivent. Trois cas, décidés par
// `rescuedRemovals`, sans rien savoir d'un outil ni d'un type :
//
//   a. le job n'a jamais écrit de contenu à cette adresse : il a retiré un
//      fichier qu'il n'a pas créé (la forme de #916). Absence verte ;
//   b. il y a écrit un contenu, et ce contenu existe encore à une autre adresse
//      du job (un déplacement, un renommage, par n'importe quel outil) :
//      absence verte pour la source ;
//   c. il y a écrit un contenu, et ce contenu n'est plus nulle part : la preuve
//      du type, donc `exists`, donc rouge — comme sur main, réparation
//      comprise. Un fichier temporaire que le job crée puis efface est donc
//      rouge, comme sur main : c'est la conséquence de la règle, pas un cas.
//
// « LE JOB A ÉCRIT » se lit dans `constated_writes`, la source qu'utilise déjà
// la porte d'écrasement (`currentContentWrittenByJob`), et SEULEMENT sur les
// tours de ses appels d'outils : l'écriture que la PLATEFORME fait pour le job
// (`PLATFORM_WRITE_TURN`, un fichier reçu par un canal, #918) n'est pas un
// travail du job. C'est la copie d'un message que la personne a encore dans son
// canal ; l'effacer à sa demande n'est pas perdre ce que le run a produit.
// Reçu puis déplacé dans un dossier : vert dans les deux lectures (cas a ou b).
//
// Un fichier qui existait avant le job et que le job a MODIFIÉ puis effacé
// relève du cas c quand la modification n'est plus nulle part : ce que le run
// a écrit est perdu, et c'est ce que la preuve doit dire.
//
// OÙ LE CONTENU PEUT ÊTRE ALLÉ — LES CANDIDATS, LUS DANS LES FAITS RANGÉS, JAMAIS
// UN BALAYAGE (revue A de la PR #919, passes 2 et 3). La première version
// lisait et hachait en entier CHAQUE chemin constaté du job, pour chaque ligne
// retirée, verrou du job tenu : un job de médias à dix sorties de 300 Mo qui
// rangeait un brouillon lisait 3 Go au moment où la personne attend.
//
// LA CHAÎNE. Un contenu peut avoir fait plusieurs pas (`mv a b`, puis
// `mv b c`, ou deux `file_move`). On la suit dans les `constated_writes` du
// job, sans rien lire sur le disque, à partir de l'adresse retirée et des tours
// où elle a été constatée `deleted`. Une ligne de constat est un pas de la
// chaîne quand :
//
//   - son empreinte RANGÉE est celle du contenu perdu (l'outil qui l'a écrit a
//     rapporté ces octets-là) ;
//   - elle porte `renamed_from` = un chemin déjà dans la chaîne (un renommage
//     vu par git) ;
//   - elle est apparue, sans empreinte rangée, au TOUR où un chemin de la
//     chaîne a été retiré : un `file_move`, ou un `mv` de shell vu par
//     l'instantané de checkpoint, crée sa destination dans l'appel qui retire
//     sa source, et ne rapporte pas d'octets.
//
// Un pas que le constat montre lui-même retiré plus tard entre dans la chaîne
// avec ses propres tours de retrait ; les autres sont les CANDIDATS. Chaque
// ligne de constat est prise au plus une fois.
//
// LE FILTRE DE TAILLE. La sonde d'avant l'appel a vu la taille de l'adresse
// retirée (`removed_size`). Un candidat n'est lu que si son `stat` rend cette
// taille-là : un fichier d'une autre taille ne porte pas ces octets, et un
// brouillon de 2 Ko ne fait plus lire un rendu de 300 Mo né au même tour.
//
// LE PLAFOND. Ce qu'une finalisation hache est borné : `RESCUE_LIMITS`, en
// fichiers et en octets, cumulés sur toutes les lignes retirées. La décision se
// prend AVANT de lire, sur les candidats d'une ligne qui ont passé le filtre de
// taille : s'ils dépassent ce qui reste, la ligne n'est pas sauvée — elle garde
// la preuve de son type, donc son rouge — et c'est dit
// (`VERIFICATION_RESCUE_CAP_REACHED`). Jamais une lecture partielle, jamais un
// repli muet.
//
// Un candidat est lu EN FLUX (une empreinte, pas un tampon), une seule fois par
// finalisation. Une lecture qui échoue se DIT (`VERIFICATION_RESCUE_UNREADABLE`)
// et ne sauve rien. Ce qui n'est pas dans la chaîne n'est jamais ouvert : un
// shell qui déplace hors de tout constat reste au cas c, rouge.
//
// LA BORNE, pour une finalisation, en ce que le job a produit :
//   - aucune ligne retirée non promise : un `select`, rien d'autre ;
//   - sinon : un `select` des constats du job (R lignes), la chaîne en
//     O(R × longueur de la chaîne) en mémoire, un `stat` par candidat distinct,
//     et au plus `maxFiles` lectures et `maxBytes` octets hachés — chaque
//     lecture d'un fichier qui a la taille exacte du contenu retiré.
//
// HORS DU VERROU : `rescuedRemovals` tourne AVANT la transaction 1 de la
// finalisation, qui ne fait que relire sa réponse. Voir `finalize.ts` pour ce
// qui garde la réponse juste entre les deux.

import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { and, constatedWrites, desc, eq, jobDeliverableVerificationState } from '@nodal-agents/db';
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

type Constat = {
  readonly path: string;
  readonly turn: number;
  readonly changeKind: string;
  readonly renamedFrom: string | null;
  readonly sha: string | null;
};

/**
 * Les chemins où le contenu retiré de `ici` peut vivre encore : la chaîne de
 * l'en-tête, suivie dans les constats seuls. Aucune lecture de disque.
 */
export function rescueCandidates(
  ecritures: readonly Constat[],
  ici: string,
  perdus: ReadonlySet<string>,
  depuis: number,
): ReadonlySet<string> {
  const retraits = (path: string, apres: number): Set<number> =>
    new Set(
      ecritures
        .filter((e) => e.path === path && e.changeKind === 'deleted' && e.turn >= apres)
        .map((e) => e.turn),
    );
  const chaine = new Map<string, Set<number>>([[ici, retraits(ici, depuis)]]);
  const file = [ici];
  const pris = new Set<number>();
  const candidats = new Set<string>();
  while (file.length > 0) {
    const chemin = file.shift() as string;
    const tours = chaine.get(chemin) ?? new Set<number>();
    for (const [i, e] of ecritures.entries()) {
      if (pris.has(i) || e.changeKind === 'deleted' || chaine.has(e.path)) continue;
      const pas =
        (e.sha !== null && perdus.has(e.sha)) ||
        e.renamedFrom === chemin ||
        (e.sha === null && tours.has(e.turn));
      if (!pas) continue;
      pris.add(i);
      const plusTard = retraits(e.path, e.turn);
      if (plusTard.size > 0) {
        // Ce pas a lui-même été retiré : la chaîne continue depuis lui.
        chaine.set(e.path, plusTard);
        file.push(e.path);
        candidats.delete(e.path);
      } else {
        candidats.add(e.path);
      }
    }
  }
  return candidats;
}

/**
 * Les empreintes que le contenu de `path` peut avoir eues à sa dernière
 * écriture avant le tour `avant` — sans rien lire.
 *
 * L'empreinte rangée quand l'écrivain l'a rapportée. Sinon (un `file_move`, un
 * `mv` de shell ne rapportent pas d'octets), celles du contenu qui est ARRIVÉ
 * là : les chemins retirés au tour de cette écriture et `renamed_from`, en
 * remontant. C'est ce qui sauve le pas intermédiaire d'une chaîne de
 * `file_move` (a → b → c) : `b` n'a pas d'empreinte rangée, mais il portait
 * celle de `a`. Le tour de la plateforme compte ici : on cherche l'IDENTITÉ
 * d'un contenu, pas qui l'a écrit. Plusieurs retraits au même tour donnent
 * plusieurs empreintes possibles, toutes acceptées : un appel qui déplace deux
 * fichiers ne dit pas lequel va où.
 */
export function contenusPossibles(
  ecritures: readonly Constat[],
  path: string,
  avant: number,
  vus: Set<string> = new Set(),
): ReadonlySet<string> {
  const out = new Set<string>();
  if (vus.has(path)) return out;
  vus.add(path);
  const w = ecritures.find((e) => e.path === path && e.changeKind !== 'deleted' && e.turn <= avant);
  if (!w) return out;
  if (w.sha !== null) return new Set([w.sha]);
  const sources = new Set<string>(
    ecritures
      .filter((e) => e.changeKind === 'deleted' && e.turn === w.turn && e.path !== path)
      .map((e) => e.path),
  );
  if (w.renamedFrom !== null) sources.add(w.renamedFrom);
  for (const source of sources) {
    for (const sha of contenusPossibles(ecritures, source, w.turn, vus)) out.add(sha);
  }
  return out;
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
      changeKind: constatedWrites.changeKind,
      renamedFrom: constatedWrites.renamedFrom,
      sha: constatedWrites.contentSha256,
    })
    .from(constatedWrites)
    .where(eq(constatedWrites.jobId, jobId))
    .orderBy(desc(constatedWrites.createdAt));

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
    const address = row.displayPathSnapshot ?? row.canonicalKey;
    if (!isAbsolute(address)) continue;
    const ici = await cheminConstate(address);
    const derniere = ecritures.find(
      (e) => e.path === ici && e.turn !== PLATFORM_WRITE_TURN && e.changeKind !== 'deleted',
    );
    // Cas a : le job n'a rien écrit ici.
    if (!derniere) {
      out.set(row.id, row.dirtyGeneration);
      continue;
    }
    // Un contenu dont l'empreinte n'a pas été rangée ne se retrouve nulle part.
    const perdus =
      derniere.sha !== null
        ? new Set([derniere.sha])
        : contenusPossibles(ecritures, ici, derniere.turn);
    if (perdus.size === 0) continue;

    // Les candidats qui ont la taille du contenu retiré — sans rien lire.
    const aLire: { path: string; size: number }[] = [];
    for (const c of rescueCandidates(ecritures, ici, perdus, derniere.turn)) {
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
      // Cas b : le contenu que le job a écrit ici existe encore ailleurs.
      const lu = lues.get(c.path);
      if (lu !== null && lu !== undefined && perdus.has(lu)) {
        out.set(row.id, row.dirtyGeneration);
        break;
      }
    }
  }
  return out;
}

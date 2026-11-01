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
// UN BALAYAGE (revue A de la PR #919, passe 2). La première version lisait et
// hachait en entier CHAQUE chemin constaté du job, pour chaque ligne retirée,
// verrou du job tenu : un job de médias à dix sorties de 300 Mo qui rangeait un
// brouillon lisait 3 Go au moment où la personne attend. Un fichier n'est lu que
// si les `constated_writes` du job en font un candidat :
//
//   - son empreinte RANGÉE est celle du contenu perdu (l'outil qui l'a écrit a
//     rapporté ces octets-là) ;
//   - il porte `renamed_from` = l'adresse retirée (un renommage vu par git) ;
//   - il est apparu, sans empreinte rangée, au TOUR même où l'adresse a été
//     retirée (le `deleted` constaté) : un `file_move`, ou un `mv` de shell vu
//     par l'instantané de checkpoint, crée sa destination dans l'appel qui
//     retire sa source, et ne rapporte pas d'octets.
//
// Un candidat est d'abord `stat`é (un fichier, là), puis lu EN FLUX une seule
// fois par finalisation, toutes lignes retirées confondues. Aucun autre fichier
// n'est ouvert. Ce qui n'a pas d'empreinte rangée et n'est pas né au tour du
// retrait n'est pas un candidat : rouge, faute de fait qui le désigne — un shell
// qui déplace hors de tout constat reste au cas c. Une lecture de candidat qui
// échoue se DIT (`VERIFICATION_RESCUE_UNREADABLE`) et ne sauve rien.
//
// LA BORNE, pour une finalisation : un `select` des lignes retirées, un
// `select` des constats du job, puis au plus un `stat` et une lecture complète
// par CHEMIN CANDIDAT distinct — jamais par chemin constaté, jamais par ligne
// retirée. Sans ligne retirée non promise, aucun constat n'est lu.
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

/** L'empreinte d'un candidat, lue en flux : `null` quand il n'est pas un fichier là. */
async function empreinteCandidat(path: string): Promise<string | null> {
  try {
    const s = await stat(path);
    if (!s.isFile()) return null;
  } catch {
    return null;
  }
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
): Promise<ReadonlyMap<string, number>> {
  const out = new Map<string, number>();
  const retirees = await db
    .select({
      id: jobDeliverableVerificationState.id,
      canonicalKey: jobDeliverableVerificationState.canonicalKey,
      displayPathSnapshot: jobDeliverableVerificationState.displayPathSnapshot,
      dirtyGeneration: jobDeliverableVerificationState.dirtyGeneration,
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

  // Une lecture par chemin candidat et par finalisation, toutes lignes confondues.
  const lues = new Map<string, Promise<string | null>>();
  const lire = (path: string): Promise<string | null> => {
    let p = lues.get(path);
    if (!p) {
      p = empreinteCandidat(path);
      lues.set(path, p);
    }
    return p;
  };

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
    const perdu = derniere.sha;
    if (perdu === null) continue;
    // Le tour où l'adresse a été retirée, quand un constat l'a vu.
    const retrait = ecritures.find((e) => e.path === ici && e.changeKind === 'deleted');
    const candidats = new Set<string>();
    for (const e of ecritures) {
      if (e.path === ici || e.changeKind === 'deleted') continue;
      if (
        e.sha === perdu ||
        e.renamedFrom === ici ||
        (e.sha === null && retrait !== undefined && e.turn === retrait.turn)
      ) {
        candidats.add(e.path);
      }
    }
    for (const c of candidats) {
      // Cas b : le contenu que le job a écrit ici existe encore ailleurs.
      if ((await lire(c)) === perdu) {
        out.set(row.id, row.dirtyGeneration);
        break;
      }
    }
  }
  return out;
}

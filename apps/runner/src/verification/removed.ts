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
// `removalLosesWork`, sans rien savoir d'un outil ni d'un type :
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
// « Une autre adresse du job » : les autres lignes d'état du job ET les
// chemins de ses `constated_writes`. Un `mv` de shell n'ouvre aucune ligne
// d'état pour sa destination ; c'est le constat (git, ou l'instantané de
// checkpoint hors dépôt) qui la nomme. Un shell qui déplace un fichier hors de
// tout ce qui est constaté reste au cas c : rouge, faute de pouvoir montrer le
// contenu ailleurs.

import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { constatedWrites, desc, eq } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { PLATFORM_WRITE_TURN, cheminConstate, fingerprint } from '@nodal-agents/tools';
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
 * Retirer ce livrable a-t-il PERDU un travail du job ? (cas c de l'en-tête)
 *
 * `address` est l'adresse retirée ; `otherAddresses`, celles des autres lignes
 * d'état du job. Lit `constated_writes` (la dernière écriture du job à cette
 * adresse, hors tour de la plateforme) puis le disque (l'empreinte actuelle des
 * autres adresses du job). Une écriture sans empreinte (un shell qui écrit
 * sans rapporter ses octets) ne peut pas être retrouvée ailleurs : perdue.
 */
export async function removalLosesWork(
  tx: AnyDrizzleDb,
  jobId: string,
  address: string,
  otherAddresses: readonly string[],
): Promise<boolean> {
  const ici = await cheminConstate(address);
  const ecritures = await tx
    .select({
      path: constatedWrites.path,
      turn: constatedWrites.turn,
      changeKind: constatedWrites.changeKind,
      sha: constatedWrites.contentSha256,
    })
    .from(constatedWrites)
    .where(eq(constatedWrites.jobId, jobId))
    .orderBy(desc(constatedWrites.createdAt));
  const derniere = ecritures.find(
    (e) => e.path === ici && e.turn !== PLATFORM_WRITE_TURN && e.changeKind !== 'deleted',
  );
  // Cas a : le job n'a rien écrit ici.
  if (!derniere) return false;
  if (derniere.sha === null) return true;
  const ailleurs = new Set<string>();
  for (const a of otherAddresses) {
    if (isAbsolute(a)) ailleurs.add(await cheminConstate(a));
  }
  for (const e of ecritures) ailleurs.add(e.path);
  ailleurs.delete(ici);
  for (const autre of ailleurs) {
    const f = await fingerprint(autre);
    // Cas b : le contenu que le job a écrit ici existe encore ailleurs.
    if (f.kind === 'file' && f.sha256 === derniere.sha) return false;
  }
  return true;
}

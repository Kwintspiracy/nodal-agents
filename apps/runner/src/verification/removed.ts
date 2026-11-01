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

import { stat } from 'node:fs/promises';
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

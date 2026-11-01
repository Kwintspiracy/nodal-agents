// verification/removed.ts — la preuve d'un livrable que le job a RETIRÉ (#916).
//
// Le seam d'exécution pose `removed` sur une ligne d'état quand l'adresse du
// livrable était là avant un appel du job et n'y est plus après, et
// `moved_to_key` quand cet appel avait DÉCLARÉ le déplacement de ce chemin vers
// une destination qui est elle-même un livrable du job
// (`packages/tools/src/verification/removed.ts`).
//
// DEUX ISSUES, et seulement deux :
//   - DÉPLACÉ (déclaré, destination retrouvée parmi les lignes du job) : un
//     seul constat, `absent:moved-to <destination>`, vert tant que l'adresse
//     est vide, rouge si un fichier y revient. La destination est jugée par sa
//     propre ligne : si elle disparaît ou change, c'est ELLE qui rougit, et le
//     run avec elle ;
//   - RETIRÉ SANS DÉPLACEMENT DÉCLARÉ (un `rm`, un `mv` de shell, une copie
//     puis une suppression) : la règle de main, `exists`, rouge — sous le nom
//     `exists:removed-by-this-run`, pour que la page du run dise d'où vient
//     l'absence. Un fichier revenu depuis reprend la preuve de son type.
//
// POURQUOI UN CONSTAT, ET PAS UNE LIGNE QUI SORT DE LA PREUVE : la page du run
// doit dire « déplacé vers X », et un fichier qui revient à l'adresse d'un
// déplacement n'est plus ce que le job a laissé.
//
// LE MÊME POUR TOUT TYPE. Le vérificateur du type est enveloppé, jamais
// remplacé dans le registre : la primitive terminale n'apprend aucun nom de
// type (T13(c)). LE CONSTAT N'A PAS DE POUVOIR : il ne lance rien, il fait un
// `stat`.

import { stat } from 'node:fs/promises';
import type {
  DeliverableVerifier,
  LoadedConfig,
  OnCommandDone,
  ProofCommandRecord,
  ProofResult,
  ProofScope,
  ReadyConfig,
  VerifierTarget,
} from './types.ts';

/** Le préfixe du constat d'un déplacement, tel que la page du run l'affiche. */
export const MOVED_PROOF_COMMAND = 'absent:moved-to';
/** Le nom du constat d'un retrait non déclaré, tel que la page du run l'affiche. */
export const REMOVED_PROOF_COMMAND = 'exists:removed-by-this-run';

/** Le préfixe du manifeste : il dit aussi à `runProof` quelle issue a été choisie. */
const MOVED_MANIFEST = 'moved-v1';
const REMOVED_MANIFEST = 'removed-v2';

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

async function emit(record: ProofCommandRecord, onCommandDone: OnCommandDone): Promise<void> {
  try {
    await onCommandDone(record);
  } catch (error) {
    console.warn(
      `[verification] REMOVED_RECORD_CALLBACK_FAILED ` +
        `error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Le vérificateur d'un livrable retiré par un appel du job : celui du type pour
 * son identité et pour un fichier revenu, l'issue de l'en-tête sinon.
 *
 * `movedTo` : le chemin d'affichage de la destination déclarée et retrouvée,
 * ou `null` pour un retrait sans déplacement déclaré.
 */
export function removedDeliverableVerifier(
  base: DeliverableVerifier,
  movedTo: string | null,
): DeliverableVerifier {
  return {
    deliverableType: base.deliverableType,
    canonicalize: (raw) => base.canonicalize(raw),

    // L'adresse est la règle de la preuve d'un document (constat C2) : le
    // chemin d'affichage, la clé à défaut. Son état entre dans le manifeste :
    // un fichier qui revient pendant la preuve la rend périmée.
    async loadConfig(tx, target: VerifierTarget): Promise<LoadedConfig> {
      const path = target.displayPath ?? target.canonicalKey;
      const seen = await presence(path);
      // Retiré sans déplacement, mais revenu depuis : la preuve du type.
      if (movedTo === null && seen.presence === 'present') return base.loadConfig(tx, target);
      const prefix = movedTo === null ? REMOVED_MANIFEST : MOVED_MANIFEST;
      return {
        kind: 'ready',
        manifestHash: `${prefix}:${seen.presence}`,
        cwd: path,
        subject: path,
        commands: [],
        epoch: 0,
      };
    },

    async runProof(
      config: ReadyConfig,
      onCommandDone: OnCommandDone,
      scope: ProofScope,
    ): Promise<ProofResult> {
      const moved = config.manifestHash.startsWith(`${MOVED_MANIFEST}:`);
      const removed = config.manifestHash.startsWith(`${REMOVED_MANIFEST}:`);
      if (!moved && !removed) return base.runProof(config, onCommandDone, scope);
      const path = config.subject;
      if (path === undefined) throw new Error(`REMOVED_CONFIG_WITHOUT_SUBJECT: ${config.cwd}`);
      const t0 = Date.now();
      const seen = await presence(path);
      const record: ProofCommandRecord = moved
        ? {
            rank: 1,
            command: `${MOVED_PROOF_COMMAND} ${movedTo}`,
            outcomeKind: 'exit',
            exitCode: seen.presence === 'absent' ? 0 : 1,
            stdoutTail: seen.presence === 'absent' ? `${path} moved to ${movedTo} by this run` : '',
            stderrTail:
              seen.presence === 'present'
                ? `${path} exists again: this run moved it to ${movedTo}`
                : seen.presence === 'unknown'
                  ? `${path} could not be checked (${seen.code})`
                  : '',
            durationMs: Date.now() - t0,
            verdict: seen.presence === 'absent' ? 'green' : 'red',
          }
        : {
            rank: 1,
            command: REMOVED_PROOF_COMMAND,
            outcomeKind: 'exit',
            exitCode: 1,
            stdoutTail: '',
            stderrTail:
              seen.presence === 'unknown'
                ? `${path} could not be checked (${seen.code})`
                : `${path} not found: a call of this run removed it, and declared no move`,
            durationMs: Date.now() - t0,
            verdict: 'red',
          };
      await emit(record, onCommandDone);
      return {
        verdict: record.verdict,
        records: [record],
        provedManifestHash: `${moved ? MOVED_MANIFEST : REMOVED_MANIFEST}:${seen.presence}`,
      };
    },
  };
}

// verification/code-project.ts — le vérificateur du livrable « projet de code ».
//
// LE SEUL fichier du chemin de vérification autorisé à écrire le littéral
// `'code_project'`, et le seul à savoir que la configuration de preuve d'un
// projet vit dans `code_projects` (décision n°9 du plan « Vérifier &
// Corriger », correction T19 : « T19 absorbe tout ce que T09 mettait de
// propre au code dans finalize.ts »).
//
// Ce qu'il porte, et que la primitive terminale ignore désormais :
//   - la clé d'identité d'un projet, c'est `projectKey` (@nodal-agents/shared,
//     une seule copie dans tout le dépôt) ;
//   - le verrou : `SELECT … FOR UPDATE` sur `code_projects` par
//     (entity_id, project_key) — pris DANS la transaction de l'appelant, qui
//     l'appelle dans un ordre déterministe ;
//   - la règle `verify_commands IS NULL ⇒ not_configured` — un projet sans
//     séquence déclarée n'est pas rouge, il est NON VÉRIFIABLE ;
//   - le manifeste (D1) et sa comparaison à `verify_approved_manifest_hash` :
//     toute divergence retombe en `pending_approval` et RIEN n'est lancé. Une
//     commande de preuve est un pouvoir ; seule la révision exacte approuvée
//     par le propriétaire s'exécute ;
//   - la séquence elle-même (`runCommandSequence`, arrêt au premier non-vert),
//     avec l'environnement filtré (`buildChildEnv`) et la capture en QUEUE :
//     l'erreur d'un test est à la fin, jamais au début.
//
// La preuve tourne HORS transaction (décision n°5) : `runProof` ne reçoit
// aucun `tx`, seulement un callback. Un spawn de plusieurs secondes sous
// `FOR UPDATE` heurterait `lock_timeout` et bloquerait le heartbeat.

import { and, eq } from '@nodal-agents/db';
import { codeProjects } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import {
  ENV_ALLOWLIST_VERSION,
  SHELL_POLICY_VERSION,
  hashVerificationManifest,
  projectKey,
} from '@nodal-agents/shared';
import type { RunVerdict } from '@nodal-agents/shared';
import { buildChildEnv, isGreen, runCommandSequence } from '@nodal-agents/tools';
import type {
  DeliverableVerifier,
  LoadedConfig,
  OnCommandDone,
  ProofCommandRecord,
  ProofResult,
  ReadyConfig,
  VerifierTarget,
} from './registry.ts';

/**
 * Plafond de capture par flux, en caractères — 16 Ko de QUEUE par commande.
 * Borné ICI, à la capture, plutôt qu'au moment de l'écriture : ce qui n'est
 * pas gardé n'est jamais accumulé en mémoire non plus.
 */
export const MAX_TAIL_CHARS = 16_384;

/** Journalisé quand l'écriture d'observabilité de l'appelant échoue (best-effort). */
export const VERIFY_RUN_CALLBACK_FAILED = 'VERIFY_RUN_CALLBACK_FAILED';
/** Une ligne `code_projects` porte une liste de commandes VIDE — malformée, dite, traitée comme non configurée. */
export const VERIFY_CONFIG_EMPTY_LIST = 'VERIFY_CONFIG_EMPTY_LIST';

const codeProjectDeliverableType = 'code_project' as const;

/**
 * Lit la configuration de preuve du projet, sous verrou, dans la transaction
 * de l'appelant. Aucune ligne `code_projects` ⇒ `not_configured` : le
 * propriétaire n'a ni renommé, ni masqué, ni configuré — il n'y a rien à
 * prouver, et ce n'est pas une erreur.
 */
async function loadConfig(tx: AnyDrizzleDb, target: VerifierTarget): Promise<LoadedConfig> {
  const rows = await tx
    .select({
      projectPath: codeProjects.projectPath,
      verifyCommands: codeProjects.verifyCommands,
      verificationEpoch: codeProjects.verificationEpoch,
      verifyApprovedManifestHash: codeProjects.verifyApprovedManifestHash,
    })
    .from(codeProjects)
    .where(
      and(
        eq(codeProjects.entityId, target.entityId),
        eq(codeProjects.projectKey, target.canonicalKey),
      ),
    )
    .for('update');

  const row = rows[0];
  if (!row) return { kind: 'not_configured' };
  const commands = row.verifyCommands;
  if (commands === null) return { kind: 'not_configured' };
  if (commands.length === 0) {
    // MALFORMÉE : le CHECK de la colonne et VerifyCommandsSchema exigent 1 à 5
    // commandes. Une liste vide n'est pas « rien à prouver », c'est une ligne
    // que rien n'aurait dû écrire — dite par un code, puis traitée comme non
    // configurée pour ne pas bloquer la finalisation en ① (observation).
    console.warn(`[verification] ${VERIFY_CONFIG_EMPTY_LIST}`, {
      entityId: target.entityId,
      key: target.canonicalKey,
    });
    return { kind: 'not_configured' };
  }

  // Le manifeste couvre TOUT ce qui change le sens de la preuve : les
  // commandes et leur ordre, la cible, le répertoire, et les deux versions de
  // politique. Changer l'un d'eux invalide l'approbation entière.
  const manifestHash = hashVerificationManifest({
    verifierConfig: commands,
    invariants: [],
    canonicalKey: target.canonicalKey,
    cwd: row.projectPath,
    shellPolicyVersion: SHELL_POLICY_VERSION,
    envAllowlistVersion: ENV_ALLOWLIST_VERSION,
  });

  if (row.verifyApprovedManifestHash !== manifestHash) {
    return { kind: 'pending_approval', manifestHash, epoch: row.verificationEpoch };
  }
  return {
    kind: 'ready',
    manifestHash,
    cwd: row.projectPath,
    commands,
    epoch: row.verificationEpoch,
  };
}

/** Le verdict d'UNE commande : vert, rouge (sortie non nulle), ou panne d'infra. */
function verdictOf(outcomeKind: 'exit' | 'timeout' | 'spawn_error', green: boolean): RunVerdict {
  if (green) return 'green';
  return outcomeKind === 'exit' ? 'red' : 'infra_error';
}

/**
 * Lance la séquence approuvée. Rend le verdict d'ensemble ET la trace par
 * commande.
 *
 * L'échec du callback est AVALÉ avec un code (décision n°4 : en ①,
 * `verification_runs` est de l'observabilité best-effort — une panne
 * d'écriture ne change jamais l'issue d'un job). `runCommandSequence`
 * interromprait la séquence sur un callback qui rejette ; c'est ici qu'on
 * décide que la preuve prime sur sa trace. L'appelant avale AUSSI de son côté
 * — les deux gardes ont chacune leur raison : celle-ci protège le verdict
 * contre un appelant fragile, celle de l'appelant nomme la table qui a lâché.
 */
async function runProof(config: ReadyConfig, onCommandDone: OnCommandDone): Promise<ProofResult> {
  const records: ProofCommandRecord[] = [];
  const sequence = await runCommandSequence(config.commands, {
    cwd: config.cwd,
    env: buildChildEnv(process.env),
    keep: 'tail',
    maxChars: MAX_TAIL_CHARS,
    onCommandDone: async (step) => {
      const green = isGreen(step.outcome);
      const record: ProofCommandRecord = {
        rank: step.rank,
        command: step.command,
        outcomeKind: step.outcome.kind,
        exitCode: step.outcome.kind === 'exit' ? step.outcome.exitCode : null,
        stdoutTail: step.stdout,
        stderrTail:
          step.outcome.kind === 'spawn_error'
            ? `${step.stderr}${step.outcome.message}`
            : step.stderr,
        durationMs: step.durationMs,
        verdict: verdictOf(step.outcome.kind, green),
      };
      records.push(record);
      try {
        await onCommandDone(record);
      } catch (error) {
        console.warn(`[verification] ${VERIFY_RUN_CALLBACK_FAILED}`, {
          rank: record.rank,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
  return { verdict: sequence.verdict, records };
}

/** Le vérificateur, tel que le registre l'indexe (il porte son propre type). */
export const codeProjectVerifier: DeliverableVerifier = {
  deliverableType: codeProjectDeliverableType,
  canonicalize: projectKey,
  loadConfig,
  runProof,
};

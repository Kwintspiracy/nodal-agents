// verification/types.ts — LE contrat qu'un type de livrable doit remplir.
//
// Séparé de `registry.ts` pour une raison mécanique, pas esthétique : le
// registre importe la VALEUR `codeProjectVerifier`, et le vérificateur importe
// le TYPE `DeliverableVerifier`. Les deux dans un seul fichier font un cycle
// d'import que `pnpm deps:check` refuse (dependency-cruiser, `no-circular`) —
// trouvé par la CI de la PR #46. Le contrat vit donc ici, sans dépendance vers
// aucun vérificateur : registre et vérificateurs le lisent tous les deux, dans
// un seul sens.
//
// Trois verbes suffisent à la primitive terminale (décision n°9 du plan
// « Vérifier & Corriger ») :
//
//   canonicalize — d'une désignation brute (un chemin, demain un id de
//                  document) vers la clé stable qui identifie le livrable ;
//   loadConfig   — sous verrou, DANS la transaction de l'appelant : ce que ce
//                  livrable est censé prouver, et si l'owner l'a approuvé ;
//   runProof     — HORS transaction (décision n°5) : la preuve elle-même.

import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { DeliverableType, RunVerdict, VerifyCommand } from '@nodal-agents/shared';

/** Le livrable visé : l'espace qui le possède, et sa clé canonique. */
export interface VerifierTarget {
  readonly entityId: string;
  readonly canonicalKey: string;
}

/** Configuration prête à prouver — le manifeste correspond à l'approbation. */
export interface ReadyConfig {
  readonly kind: 'ready';
  /** Empreinte (D1) du manifeste sous lequel la preuve va tourner. */
  readonly manifestHash: string;
  /** Répertoire d'exécution de la séquence. */
  readonly cwd: string;
  readonly commands: readonly VerifyCommand[];
  /** `verification_epoch` de la cible au moment de la lecture. */
  readonly epoch: number;
}

/**
 * Ce que `loadConfig` peut rendre. Aucune autre issue : une configuration
 * illisible LÈVE, elle ne retombe pas sur « pas configuré ».
 */
export type LoadedConfig =
  | ReadyConfig
  | { readonly kind: 'not_configured' }
  | { readonly kind: 'pending_approval'; readonly manifestHash: string; readonly epoch: number };

/** La trace d'UNE commande de preuve — ce que l'appelant persiste par rang. */
export interface ProofCommandRecord {
  readonly rank: number;
  readonly command: string;
  /** Les trois issues du moteur shell, jamais confondues. */
  readonly outcomeKind: 'exit' | 'timeout' | 'spawn_error';
  /** `null` hors `exit` — un timeout n'a pas de code de sortie. */
  readonly exitCode: number | null;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly durationMs: number;
  readonly verdict: RunVerdict;
}

/**
 * Appelé après CHAQUE commande, avant la suivante. L'appelant y écrit sa
 * ligne d'observabilité. Son échec ne casse pas la preuve (décision n°4 :
 * `verification_runs` est best-effort en ①) — le vérificateur l'avale et
 * journalise un code.
 */
export type OnCommandDone = (record: ProofCommandRecord) => Promise<void>;

export interface ProofResult {
  readonly verdict: RunVerdict;
  /** Une entrée par commande LANCÉE — celles qui suivent un rouge n'existent pas. */
  readonly records: readonly ProofCommandRecord[];
}

/**
 * Ce qu'un type de livrable doit savoir faire pour entrer dans la boucle de
 * vérification. `runProof` ne reçoit AUCUNE transaction : la preuve tourne
 * hors transaction (décision n°5), un spawn de plusieurs secondes ne tient
 * aucun verrou.
 */
export interface DeliverableVerifier {
  readonly deliverableType: DeliverableType;
  canonicalize(raw: string): string;
  loadConfig(tx: AnyDrizzleDb, target: VerifierTarget): Promise<LoadedConfig>;
  runProof(config: ReadyConfig, onCommandDone: OnCommandDone): Promise<ProofResult>;
}

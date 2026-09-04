// verification/registry.ts — LE registre des vérificateurs, par type de livrable.
//
// Décision n°9 du plan « Vérifier & Corriger » (docs/plans/verifier-corriger.md,
// « Décisions de découpage ») : la primitive terminale n'appelle QUE ce
// registre. Elle ne sait pas ce qu'est un projet de code, ni où sa
// configuration de preuve est rangée, ni comment on la lance. Trois verbes
// suffisent :
//
//   canonicalize — d'une désignation brute (un chemin, demain un id de
//                  document) vers la clé stable qui identifie le livrable ;
//   loadConfig   — sous verrou, DANS la transaction de l'appelant : ce que ce
//                  livrable est censé prouver, et si l'owner l'a approuvé ;
//   runProof     — HORS transaction (décision n°5) : la preuve elle-même.
//
// Pourquoi le registre ne connaît AUCUN nom de type en dur : chaque
// vérificateur porte le sien (`deliverableType`) et le registre s'indexe
// dessus. Le seul fichier qui écrit le littéral `'code_project'` reste
// `code-project.ts` — c'est ce qui rend atteignable la règle d'architecture
// « aucun littéral de type de livrable dans la primitive » (T13(c)).
//
// Un type sans vérificateur est REFUSÉ, jamais accepté avec une clé inventée
// (invariant #4 : pas de repli silencieux). C'est le cas de tous les types
// réservés de `DELIVERABLE_TYPES` en PR① — seul `code_project` est branché.

import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { DeliverableType, RunVerdict, VerifyCommand } from '@nodal-agents/shared';
import { codeProjectVerifier } from './code-project.ts';

/** Code d'erreur — un code et des données, jamais une phrase (invariant #2). */
export const DELIVERABLE_TYPE_UNSUPPORTED = 'DELIVERABLE_TYPE_UNSUPPORTED';

/** Levée par `getVerifier` pour un type sans vérificateur enregistré. */
export class DeliverableTypeUnsupportedError extends Error {
  readonly code = DELIVERABLE_TYPE_UNSUPPORTED;

  constructor(public readonly deliverableType: string) {
    super(`${DELIVERABLE_TYPE_UNSUPPORTED}: ${deliverableType}`);
    this.name = 'DeliverableTypeUnsupportedError';
  }
}

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

/**
 * La table du registre — construite DEPUIS les vérificateurs, jamais en
 * recopiant leurs noms ici (une deuxième liste finirait par diverger).
 */
const VERIFIERS: ReadonlyMap<string, DeliverableVerifier> = new Map(
  [codeProjectVerifier].map((verifier) => [verifier.deliverableType, verifier] as const),
);

/**
 * Le vérificateur d'un type, ou `DELIVERABLE_TYPE_UNSUPPORTED`. Jamais de
 * vérificateur par défaut : un type inconnu qui recevrait un canonicaliseur
 * générique produirait une clé inventée, donc un état de vérification qui ne
 * désigne rien.
 */
export function getVerifier(deliverableType: string): DeliverableVerifier {
  const verifier = VERIFIERS.get(deliverableType);
  if (!verifier) throw new DeliverableTypeUnsupportedError(deliverableType);
  return verifier;
}

/** La clé canonique d'un livrable — même refus pour un type sans vérificateur. */
export function canonicalKeyFor(deliverableType: string, raw: string): string {
  return getVerifier(deliverableType).canonicalize(raw);
}

/** Les types réellement branchés — lu par les tests d'architecture. */
export function registeredDeliverableTypes(): readonly string[] {
  return [...VERIFIERS.keys()];
}

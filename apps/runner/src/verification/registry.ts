// verification/registry.ts — LE registre des vérificateurs, par type de livrable.
//
// Décision n°9 du plan « Vérifier & Corriger » (docs/plans/verifier-corriger.md,
// « Décisions de découpage ») : la primitive terminale n'appelle QUE ce
// registre. Elle ne sait pas ce qu'est un projet de code, ni où sa
// configuration de preuve est rangée, ni comment on la lance.
//
// Le CONTRAT (les trois verbes et leurs types) vit dans `types.ts`, pas ici :
// ce fichier importe la valeur `codeProjectVerifier`, et le vérificateur
// importe le type `DeliverableVerifier` — les deux dans un même fichier font
// un cycle d'import que `pnpm deps:check` refuse (trouvé par la CI, PR #46).
// Les types sont re-exportés ci-dessous pour que les appelants n'aient qu'un
// seul point d'entrée.
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

import { codeProjectVerifier } from './code-project.ts';
import type { DeliverableVerifier } from './types.ts';

export type {
  DeliverableVerifier,
  LoadedConfig,
  OnCommandDone,
  ProofCommandRecord,
  ProofResult,
  ReadyConfig,
  VerifierTarget,
} from './types.ts';

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

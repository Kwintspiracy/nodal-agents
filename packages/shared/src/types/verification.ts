// verification.ts — les types du plan « Vérifier & Corriger », partagés
// runner / web / tools.
//
// Le vocabulaire vient du plan (docs/plans/verifier-corriger.md, v6.x) et
// suit la convention d'enums.ts : un tableau `as const` = la source de vérité,
// un schéma zod dérivé, un type inféré. Les CHECK des migrations 0088-0090
// citent ces mêmes listes ; un écart entre les deux se voit au premier test
// de contrainte.

import { z } from 'zod';

/**
 * Ce qu'une tâche demande de produire (D6). C'est la clé qui choisit le
 * vérificateur ET la politique de relecture. PR① n'implémente que
 * `code_project` ; les autres valeurs sont réservées, sans canonicaliseur —
 * un type sans canonicaliseur est refusé, jamais accepté avec une clé inventée.
 */
export const DELIVERABLE_TYPES = [
  'code_project',
  'office_file',
  'document',
  'outbound_action',
  'other',
] as const;
export const DeliverableTypeSchema = z.enum(DELIVERABLE_TYPES);
export type DeliverableType = z.infer<typeof DeliverableTypeSchema>;

/** Types dont le livrable se modifie puis se prouve (générations sale / vérifiée). */
export const MUTABLE_DELIVERABLE_TYPES = [
  'code_project',
  'office_file',
  'document',
  'other',
] as const;
/** Types dont le livrable se tente puis se constate (machine d'état `AtomicOutcome`). */
export const ATOMIC_DELIVERABLE_TYPES = ['outbound_action'] as const;

/** L'état lisible d'un livrable mutable dans un job (table d'état). */
export const DECISION_STATUSES = [
  'dirty',
  'green',
  'red',
  'pending_approval',
  'not_configured',
  'infra_error',
] as const;
export const DecisionStatusSchema = z.enum(DECISION_STATUSES);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

/**
 * La machine d'état d'un livrable atomique (v6-A) :
 * `prepared → attempted → confirmed | rejected | outcome_unknown`.
 * Seule la finalisation écrit `outcome_unknown`, en transformant un
 * `attempted` résiduel ; le reaper ne touche jamais une ligne `attempted`.
 */
export const ATOMIC_OUTCOMES = [
  'prepared',
  'attempted',
  'confirmed',
  'rejected',
  'outcome_unknown',
] as const;
export const AtomicOutcomeSchema = z.enum(ATOMIC_OUTCOMES);
export type AtomicOutcome = z.infer<typeof AtomicOutcomeSchema>;

/** Le verdict d'UNE commande de preuve (une ligne de `verification_runs`). */
export const RUN_VERDICTS = ['green', 'red', 'infra_error'] as const;
export const RunVerdictSchema = z.enum(RUN_VERDICTS);
export type RunVerdict = z.infer<typeof RunVerdictSchema>;

/**
 * Une commande de preuve. `timeoutSeconds` est entier et borné : une preuve
 * n'est pas un job, elle ne tourne pas une heure.
 */
export const VerifyCommandSchema = z.object({
  command: z.string().trim().min(1).max(2000),
  timeoutSeconds: z.number().int().min(1).max(3600),
});
export type VerifyCommand = z.infer<typeof VerifyCommandSchema>;

/** Nombre maximal de commandes dans une séquence de preuve (v5-A). */
export const VERIFY_COMMANDS_MAX = 5;

/**
 * La liste ORDONNÉE des commandes de preuve d'un projet (v5-A) : exécutée en
 * séquence, arrêt au premier rouge. Une seule commande reste le cas nominal —
 * la liste n'impose rien.
 */
export const VerifyCommandsSchema = z.array(VerifyCommandSchema).min(1).max(VERIFY_COMMANDS_MAX);
export type VerifyCommands = z.infer<typeof VerifyCommandsSchema>;

// ─── Classer un livrable par ce qu'il EST (v7-A) ─────────────────────────────

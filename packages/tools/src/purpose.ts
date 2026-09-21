// purpose.ts — an approval request carries the agent's own reason, or it does
// not exist.
//
// POURQUOI CE FICHIER EXISTE
// --------------------------
// La carte d'approbation montre en premier la phrase de l'agent
// (`toolInput.purpose`, lue par `explainApproval` dans @nodal-agents/shared) et,
// à défaut, dit qu'il n'a rien expliqué. Constat de Quentin le 21/09/2026 :
// cette phrase de repli était la règle, pas l'exception.
//
// La cause n'était pas la carte : un outil de gestion (`meta-ops/*`),
// `declare_verification` ou `run_schedule` n'a JAMAIS déclaré de champ
// `purpose`. Le modèle ne pouvait donc pas le remplir, et la carte ne pouvait
// que constater le vide. Un contrôle qu'on ne peut pas lire n'est pas un
// contrôle : il entraîne à cliquer sur le bouton vert.
//
// Deux pièces, dans cet ordre :
//
//   1. L'AFFORDANCE — `withStatedPurpose` pose la propriété sur le schéma que
//      le modèle reçoit. `required` quand la posture de CET agent pour CET
//      outil est « on demande d'abord », optionnelle sinon.
//   2. LE REFUS — `refuseWithoutStatedPurpose`, appelé par le gate juste avant
//      d'écrire la ligne `approval_requests`. C'est LUI qui tient la règle :
//      l'affordance se calcule sur les règles connues au moment où la liste
//      d'outils est bâtie, le refus se prononce sur l'appel réel.
//
// Un appel auto-approuvé, bloqué, ou qui POSE une question (`asksUser`) n'exige
// rien : le premier ne passe devant personne, le second ne passe pas du tout, et
// la carte d'une question rend la question elle-même — pas ce champ (voir
// `apps/web/src/app/(dashboard)/approvals/page.tsx`, branche `kind === 'question'`).

import { z } from 'zod';
import { readStatedPurpose } from '@nodal-agents/shared';
import type { ToolDefinition } from './types';

/** Le champ que la carte d'approbation rend comme la voix de l'agent. */
export const PURPOSE_KEY = 'purpose';

/**
 * Ce que le modèle lit dans le schéma. Court : la chaîne est sérialisée dans le
 * schéma de CHAQUE outil du job, donc sa longueur est multipliée par le nombre
 * d'outils, à chaque tour.
 */
export const PURPOSE_DESCRIPTION =
  'One sentence for the person who approves: what you need this for. ' +
  'Required when the call needs approval.';

/** Plafond de longueur : une phrase, pas un rapport. */
const PURPOSE_MAX = 400;

/**
 * Ce que le LLM reçoit quand il a demandé l'approbation d'une personne sans dire
 * pourquoi. Texte pour le MODÈLE, jamais pour l'écran (invariant #2 vise le
 * texte d'écran) : il nomme l'outil, le fait, et le geste exact qui répare.
 */
export function missingPurposeInstruction(toolName: string): string {
  return (
    `approval_purpose_required: "${toolName}" suspends this job until a person approves it, ` +
    `and no reason was given, so nothing was submitted to anyone. Call "${toolName}" again ` +
    `with a \`purpose\` field: one sentence, for the person who approves, saying what you ` +
    `need this for and why.`
  );
}

/** Le champ posé sur un outil dont la posture est « on demande d'abord ». */
const requiredPurposeField = (toolName: string): z.ZodType =>
  z
    .string({ error: () => missingPurposeInstruction(toolName) })
    .min(1, { error: () => missingPurposeInstruction(toolName) })
    .max(PURPOSE_MAX)
    .describe(PURPOSE_DESCRIPTION);

/**
 * Le champ posé sur un outil autonome. Optionnel ET sans minimum : une chaîne
 * vide doit traverser la validation pour que le refus du gate — qui la traite
 * comme absente, exactement comme la carte — soit ce qui parle, plutôt qu'une
 * erreur de schéma qui ne dirait pas quoi faire.
 */
const optionalPurposeField = z.string().max(PURPOSE_MAX).describe(PURPOSE_DESCRIPTION).optional();

type AnyTool = ToolDefinition<z.ZodTypeAny, unknown>;

/**
 * Poser `purpose` sur le schéma d'un outil.
 *
 * Rend l'outil INCHANGÉ dans les cas où l'ajouter serait faux :
 *
 *  - son schéma n'est pas un objet (rien à étendre) ;
 *  - il déclare DÉJÀ `purpose` (`run_command`, `file_write`, `file_edit`,
 *    `run_skill_script`, `skill_file_write`, `code_task`, et tout outil MCP,
 *    que l'adaptateur équipe lui-même). Réécrire ce champ ici écraserait sa
 *    description, et pour un serveur MCP qui déclare son propre `purpose`,
 *    un vrai argument.
 */
export function withStatedPurpose(tool: AnyTool, opts: { required: boolean }): AnyTool {
  const schema = tool.inputSchema;
  if (!(schema instanceof z.ZodObject)) return tool;
  const shape = schema.shape as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(shape, PURPOSE_KEY)) return tool;
  return {
    ...tool,
    inputSchema: schema.extend({
      [PURPOSE_KEY]: opts.required ? requiredPurposeField(tool.name) : optionalPurposeField,
    }),
  };
}

/**
 * La règle, prononcée sur l'appel réel : un appel que la porte d'approbation
 * s'apprête à suspendre porte une phrase, ou il n'existe pas.
 *
 * Rend l'instruction à renvoyer au modèle, ou `null` quand l'appel peut
 * continuer. Volontairement minuscule et pure : elle est appelée depuis
 * `executeTool`, juste avant l'insertion, et rien d'autre de ce fichier ne
 * touche au gate.
 */
export function refuseWithoutStatedPurpose(tool: AnyTool, input: unknown): string | null {
  // Une question n'a pas de « pourquoi » séparé : son texte EST le message à la
  // personne, et la carte rend ce texte.
  if (tool.asksUser === true) return null;
  if (readStatedPurpose(input) !== null) return null;
  return missingPurposeInstruction(tool.name);
}

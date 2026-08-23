// agent-slug.ts — LE contrat du slug d'agent, unique et partagé.
//
// Trois surfaces le définissaient chacune pour soi, et elles avaient dérivé
// (review PR #14) : le dashboard acceptait `^[a-z0-9-]+$` avec 80 caractères
// max, le méta-outil la même regex SANS maximum, et le serveur MCP exigeait
// `^[a-z0-9][a-z0-9-]*$` sur 120. Résultat concret : un agent nommé
// `-reviewer` pouvait être créé par deux surfaces et devenait inciblable par
// la troisième — un agent valide, actif, et injoignable sans que rien ne dise
// pourquoi.
//
// Un identifiant qui se crée ici et se résout là-bas n'a droit qu'à UNE
// définition. Elle vit ici ; les surfaces l'importent, aucune ne la recopie.

import { z } from 'zod';

/**
 * Minuscules, chiffres, tirets — et jamais un tiret en tête : un slug qui
 * commence par `-` se confond avec un drapeau dans toute CLI qui le reçoit.
 * Ce durcissement rejette une forme que les anciennes regex toléraient ;
 * les slugs existants en base restent servis (la validation porte sur les
 * ENTRÉES : création et ciblage), mais ne pourront plus être recréés.
 */
export const AGENT_SLUG_MAX = 80;

export const AgentSlugSchema = z
  .string()
  .min(1)
  .max(AGENT_SLUG_MAX)
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    'Slug must be lowercase alphanumeric with hyphens, and must not start with a hyphen.',
  );

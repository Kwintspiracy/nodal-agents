// workflows/needs.ts — ce qu'un scénario demande à la machine, et ce qui manque.
//
// Un scénario déclare ses besoins par leur NOM (`needs`) : un service local
// (ComfyUI), un coffre Obsidian, une imprimante, ou l'assurance qu'aucun
// courrier ne peut partir. Un besoin absent fait SAUTER l'essai, avec sa
// raison, sans lancer de job : ni rouge (rien n'a été essayé), ni silence (la
// ligne `skipped` le dit, le portail l'affiche en gris).
//
// Un seul mécanisme pour tous les scénarios : la liste fermée ci-dessous, et
// une fonction par besoin qui lit l'environnement de l'essai (`ScenarioEnv`).
// Aucun chemin, aucune adresse du propriétaire n'est écrit ici (invariant #6) :
// le coffre se trouve parmi les dossiers de travail, ComfyUI à l'adresse que
// ~/.nodalai/bench.json déclare.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ScenarioEnv } from './types';

/** Les besoins qu'un scénario peut déclarer. Un nom hors de cette liste ne compile pas. */
export const NEED_IDS = ['comfyui', 'obsidian-vault', 'printer', 'no-mail-sender'] as const;
export type Need = (typeof NEED_IDS)[number];

/** Le nom d'un outil, découpé en mots : `office_printer__request_print` → office, printer, request, print. */
function words(toolName: string): string[] {
  return toolName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** L'outil de l'équipe qui porte ce nom nu, quel que soit le préfixe de son serveur. */
export function teamHas(env: Pick<ScenarioEnv, 'teamTools'>, bare: string): boolean {
  return env.teamTools.some((t) => t === bare || t.endsWith(`__${bare}`));
}

/**
 * Un coffre Obsidian EST un dossier qui porte `.obsidian/` : c'est la marque que
 * l'application y pose. Le banc ne connaît aucun chemin ; il cherche cette
 * marque parmi les dossiers de travail que l'espace déclare.
 */
export function obsidianVaults(roots: readonly string[]): string[] {
  return roots.filter((r) => existsSync(join(r, '.obsidian')));
}

export const NO_VAULT =
  'no Obsidian vault is configured: no workspace folder of this workspace holds a .obsidian folder';

const SEND_VERBS = new Set(['send', 'reply', 'forward', 'draft']);
const MAIL_WORDS = new Set([
  'mail',
  'email',
  'gmail',
  'outlook',
  'smtp',
  'mailgun',
  'sendgrid',
  'postmark',
  'resend',
]);

/**
 * Un outil qui peut faire partir un courrier : son nom (préfixe du serveur
 * compris, qui porte souvent le service : `gmail_mcp__send_message`) contient
 * un verbe d'envoi ET un mot de courrier, ou `smtp`. Lire un courrier n'en
 * envoie aucun (`gmail_list_drafts`). Prudent : `gmail_create_draft` compte.
 *
 * C'est une lecture des NOMS : la plateforme ne déclare pas encore quelles
 * opérations sortent de la machine. Sa forme générale serait une marque
 * `outbound` sur chaque opération de connecteur (OperationDescriptor) et la
 * lecture de `openWorldHint` des outils MCP ; voir docs/workflow-bench.md.
 */
export function isMailSender(toolName: string): boolean {
  const w = words(toolName);
  if (w.includes('smtp')) return true;
  return w.some((x) => SEND_VERBS.has(x)) && w.some((x) => MAIL_WORDS.has(x));
}

/** Pourquoi le besoin manque, ou null quand il est là. */
const CHECKS: Record<Need, (env: ScenarioEnv) => string | null> = {
  comfyui(env) {
    const s = env.services['comfyui'];
    if (!s) {
      return 'no ComfyUI address is declared for the bench (services.comfyui in ~/.nodalai/bench.json)';
    }
    return s.problem === null ? null : `ComfyUI at ${s.url} does not answer: ${s.problem}`;
  },
  'obsidian-vault'(env) {
    return obsidianVaults(env.workspaceRoots).length > 0 ? null : NO_VAULT;
  },
  printer(env) {
    return teamHas(env, 'request_print')
      ? null
      : 'no agent of this workspace has request_print (no printer connector configured)';
  },
  'no-mail-sender'(env) {
    const senders = env.teamTools.filter(isMailSender);
    return senders.length === 0
      ? null
      : `an agent of this workspace can send e-mail (${senders.join(', ')}): the bench sends nothing from the owner's account, so this scenario does not run here`;
  },
};

/** Les raisons de sauter l'essai : une par besoin absent, vide quand tout est là. */
export function missingNeeds(needs: readonly Need[], env: ScenarioEnv): string[] {
  return needs.map((n) => CHECKS[n](env)).filter((r): r is string => r !== null);
}

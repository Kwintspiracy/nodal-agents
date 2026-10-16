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
import { NEED_IDS, type Need, type ScenarioEnv } from './types';

export { NEED_IDS, type Need };

/**
 * Le nom d'un outil, découpé en mots, camelCase compris :
 * `office_printer__request_print` → office, printer, request, print ;
 * `outlookForwardMessage` → outlook, forward, message.
 */
function words(toolName: string): string[] {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
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

/** Un mot qui commence par un verbe d'envoi (`send`, `sendmail`, `reply`, `forward`, `draft`, `drafts`). */
const SEND_VERB = /^(send|reply|forward|draft)/;
/** Un service de courrier : tout mot qui contient « mail » (gmail, mailchimp, hotmail…), ou l'un de ceux-ci. */
const MAIL_SERVICES = new Set([
  'outlook',
  'smtp',
  'sendgrid',
  'postmark',
  'resend',
  'sparkpost',
  'mandrill',
]);

/**
 * Un outil qui peut faire partir un courrier : son nom (préfixe du serveur
 * compris, qui porte souvent le service : `gmail_mcp__send_message`) contient
 * un verbe d'envoi ET un mot de courrier, ou `smtp`. Les mots sont découpés au
 * camelCase. Prudent : tout ce qui touche un brouillon
 * compte (un brouillon peut partir), lister les messages non.
 *
 * DÉFENSE EN PROFONDEUR, pas la protection. Une lecture de noms ne verra
 * jamais un envoi fait par un outil générique (`run_command` avec smtplib ou
 * curl, `run_skill_script`), et la plateforme ne déclare pas encore quelles
 * opérations sortent de la machine (sa forme générale : une marque `outbound`
 * sur chaque opération de connecteur, `openWorldHint` sur les outils MCP). La
 * vraie protection est qu'AUCUN destinataire réel n'existe dans le banc : ni
 * dans une demande, ni dans une fixture que le banc pose (seuls les domaines
 * réservés `.invalid` et `example.*`, et chaque scénario déclare où il envoie :
 * recipients.ts, prouvé par recipients.test.ts), puis,
 * plus tard, une entité « banc » dont les seuls comptes sont des comptes de
 * test. Voir docs/workflow-bench.md.
 */
export function isMailSender(toolName: string): boolean {
  const w = words(toolName);
  if (w.includes('smtp')) return true;
  return (
    w.some((x) => SEND_VERB.test(x)) && w.some((x) => x.includes('mail') || MAIL_SERVICES.has(x))
  );
}

/** Les verbes qui font sortir quelque chose de la machine, mot entier d'un nom d'outil. */
const OUTBOUND_BASES = [
  'send',
  'post',
  'publish',
  'share',
  'forward',
  'reply',
  'notify',
  'tweet',
  'broadcast',
  'upload',
  'dm',
];

/**
 * Les formes d'un verbe anglais, dérivées d'UNE règle pour tous : la base, -s,
 * -es, -ed, -d, -ing (le e final tombé : sharing), et y → ies / ied (replies,
 * notified). Les irréguliers qu'aucune règle ne donne sont listés à part.
 */
function inflections(base: string): string[] {
  const forms = [base, `${base}s`, `${base}es`, `${base}ed`, `${base}d`, `${base}ing`];
  if (base.endsWith('e')) forms.push(`${base.slice(0, -1)}ing`);
  if (base.endsWith('y')) forms.push(`${base.slice(0, -1)}ies`, `${base.slice(0, -1)}ied`);
  return forms;
}
const IRREGULAR_OUTBOUND = ['sent'];
const OUTBOUND_VERBS = new Set([...OUTBOUND_BASES.flatMap(inflections), ...IRREGULAR_OUTBOUND]);
/** Les services de messagerie : un outil qui les vise peut écrire à quelqu'un, quel que soit son verbe. */
const CHANNEL_SERVICES = new Set([
  'telegram',
  'slack',
  'discord',
  'whatsapp',
  'signal',
  'sms',
  'twilio',
  'teams',
  'mattermost',
  'messenger',
  'wechat',
  'mastodon',
  'bluesky',
  'twitter',
  'linkedin',
  'facebook',
  'instagram',
  'reddit',
]);
/**
 * Les outils INTERNES du produit que leur nom ferait prendre pour des envois :
 * la liste courte et explicite, comparée au nom ENTIER. Un outil de connecteur
 * ou de serveur MCP (`slack__file_upload`) ou d'une CLI (`cli:…`) n'en est
 * jamais un, même si son dernier segment leur ressemble (revue Reviewer A,
 * passe 4). `dashboard_publish` publie sur le tableau de bord Nodal du
 * propriétaire, sans message ni sortie de la machine.
 */
const INTERNAL_TOOLS =
  /^(return_result|dashboard_publish|file_[a-z_]+|workspace_[a-z_]+|xlsx_[a-z_]+|docx_[a-z_]+|pptx_[a-z_]+)$/;

/**
 * Un outil qui peut faire sortir quelque chose vers quelqu'un : un courrier
 * (`isMailSender`), un nom qui porte un verbe sortant (`send`, `post`,
 * `publish`, `share`, `forward`, `reply`, `notify`, `tweet`, `upload`…), qui
 * COMMENCE par « message » (`message_user`), ou qui vise un service de
 * messagerie (`slack__list_channels` compris). Fermé par défaut : un faux
 * rouge vaut mieux qu'un faux vert ; seuls les outils internes de la liste
 * courte en sont exemptés.
 *
 * Toujours une lecture de NOMS (revue Reviewer A de #756, passe 3) : la vraie
 * prévention est un espace « banc » sans canal (décision du propriétaire,
 * b1). Jusque-là, un essai sur les agents du propriétaire PEUT encore lui
 * envoyer un message ; le banc ne fait que le signaler après coup.
 */
export function isOutboundTool(toolName: string): boolean {
  // Interne seulement s'il s'agit d'un outil du produit lui-même, nommé en entier.
  const ownTool = !toolName.includes('__') && !toolName.startsWith('cli:');
  if (ownTool && INTERNAL_TOOLS.test(toolName)) return false;
  const bare = toolName.replace(/^cli:/, '').split('__').pop() ?? toolName;
  if (isMailSender(toolName)) return true;
  const w = words(toolName);
  if (w.some((x) => OUTBOUND_VERBS.has(x) || CHANNEL_SERVICES.has(x))) return true;
  return words(bare)[0] === 'message';
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
    // Fermé par défaut : un serveur MCP dont les outils ne sont pas connus peut
    // en offrir un qui envoie (le runner s'y connecte au lancement du job).
    if (env.unlistedMcpServers.length > 0) {
      return `an MCP server of this workspace has never listed its tools (${env.unlistedMcpServers.join(', ')}): the bench cannot know whether it sends e-mail, so this scenario does not run here`;
    }
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

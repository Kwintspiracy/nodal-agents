// workflows/needs.ts — ce qu'un scénario demande à la machine, et ce qui manque.
//
// Un scénario déclare ses besoins par leur NOM (`needs`) : un service local
// (ComfyUI), un coffre Obsidian, l'imprimante du banc, ou l'assurance qu'aucun
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
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
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

/**
 * Les verbes qui font sortir quelque chose de la machine. Leur forme d'ACTION
 * (base, -s, -es, -ing, e final tombé) compte ; un participe (posted, shared,
 * sent) décrit une chose (`published_at`, `sent_items`), il n'agit pas.
 */
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
function actionForms(base: string): string[] {
  const forms = [base, `${base}s`, `${base}es`, `${base}ing`];
  if (base.endsWith('e')) forms.push(`${base.slice(0, -1)}ing`);
  if (base.endsWith('y')) forms.push(`${base.slice(0, -1)}ies`);
  return forms;
}
const OUTBOUND_ACTIONS = new Set(OUTBOUND_BASES.flatMap(actionForms));
/**
 * Après un verbe de lecture, seule une BASE sortante est une action, préfixée
 * ou non de « re » (`get_and_send`, `checkBeforeSend`, `list_then_resend`).
 * Les formes en -ing, -ed et -s y désignent des choses, jamais des actions
 * (`list_sending_domains`, `get_posting_rules`, `list_posts`).
 */
const OUTBOUND_AFTER_READ = new Set(OUTBOUND_BASES.flatMap((b) => [b, `re${b}`]));

/** Les verbes qui LISENT : en position d'action, l'outil est une lecture. */
const READ_VERBS = new Set([
  'get',
  'list',
  'read',
  'search',
  'fetch',
  'find',
  'query',
  'describe',
  'count',
  'watch',
  'show',
  'view',
  'lookup',
  'check',
  'download',
  'export',
  'retrieve',
  'browse',
  'peek',
  'preview',
  'inspect',
  'poll',
]);

/** Les services de messagerie et de courrier : un outil qui les vise peut écrire à quelqu'un. */
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
  'smtp',
  'gmail',
  'outlook',
  'mail',
  'email',
]);

/**
 * Les outils INTERNES : les noms EXACTS du registre des outils du produit
 * (`registerBuiltins`, @nodal-agents/tools), lus dans le registre lui-même,
 * jamais recopiés. Tout autre nom — opération de connecteur adaptateur
 * (`drive_upload_file`, un seul « _ »), outil MCP (`x__y`), outil de CLI
 * (`cli:…`) — n'est pas interne (revue Reviewer A de #756, passe 5).
 */
let internalTools: ReadonlySet<string> | null = null;
function isInternalTool(toolName: string): boolean {
  if (internalTools === null) {
    const registry = createToolRegistry();
    registerBuiltins(registry);
    internalTools = new Set(registry.list().map((t) => t.name));
  }
  return internalTools.has(toolName);
}

/**
 * Un outil appelé pendant l'essai qui a pu faire sortir quelque chose vers
 * quelqu'un. Décidé par le verbe d'ACTION, à sa POSITION : le premier mot du
 * nom, ou le second quand le premier est un préfixe de service (`gmail_`,
 * `chat_postMessage`, `drive_upload_file`) :
 *   1. un outil interne du produit (nom exact du registre) n'envoie pas ;
 *   2. un verbe de lecture en position d'action : une lecture (`list_posts`,
 *      `get_posted_at`, `slack__list_channels`), SAUF si un verbe sortant
 *      (base ou -ing) le suit dans le nom (`get_and_send`, `checkBeforeSend`) ;
 *   3. un verbe sortant en forme d'action, en position d'action (`send_message`,
 *      `chat_postMessage`, `file_upload`) : un envoi ;
 *   4. sinon, fermé par défaut : un verbe sortant en forme d'action ailleurs
 *      dans le nom, préfixe compris (`blog__create_posts`, `notify__push`), un
 *      nom qui commence par « message », ou un service de messagerie ou de
 *      courrier (`telegram__chat`, `smtp_relay`) : un envoi.
 * Un faux rouge vaut mieux qu'un faux vert.
 *
 * C'est une ALARME, pas une porte (revue Reviewer A, passes 3 à 7). Elle lit
 * des noms et signale un envoi APRÈS COUP ; elle n'empêche rien et n'a pas
 * vocation à grandir encore. La porte, c'est l'espace « banc » (#758) : les
 * vrais essais n'y tournent que derrière un contrôle STRUCTUREL d'avant
 * essai, qui vérifie qu'aucun outil de l'équipe ne peut envoyer. Jusque-là,
 * un essai sur les agents du propriétaire PEUT encore lui envoyer un message,
 * et le banc ne fait que le dire. Une alarme qui sonne dans l'espace banc
 * signale un trou de cette porte.
 */
export function isOutboundTool(toolName: string): boolean {
  if (isInternalTool(toolName)) return false;
  const bare = toolName.replace(/^cli:/, '').split('__').pop() ?? toolName;
  const own = words(bare);
  const isVerb = (x: string | undefined): boolean =>
    x !== undefined && (READ_VERBS.has(x) || OUTBOUND_ACTIONS.has(x));
  const at = isVerb(own[0]) ? 0 : isVerb(own[1]) ? 1 : -1;
  const action = at === -1 ? undefined : own[at];
  // Une lecture, sauf si un envoi la suit dans le même outil (`get_and_send`,
  // passe 6). Un service de messagerie n'est exempté que sur une lecture PURE
  // (`slack__list_channels`).
  if (action !== undefined && READ_VERBS.has(action))
    return own.slice(at + 1).some((x) => OUTBOUND_AFTER_READ.has(x));
  if (action !== undefined && OUTBOUND_ACTIONS.has(action)) return true;
  const all = words(toolName);
  if (all.some((x) => OUTBOUND_ACTIONS.has(x) || CHANNEL_SERVICES.has(x))) return true;
  return own[0] === 'message';
}

/**
 * L'imprimante du banc (#794) : un serveur MCP d'impression que le banc
 * fournit, et qui ENREGISTRE ce qu'il a reçu. Tout essai d'impression du banc
 * tourne sur elle, jamais sur une vraie imprimante (décision du propriétaire,
 * 18/10 : « je ne vais pas imprimer 50 000 tests ») ; avoir `request_print`
 * dans l'équipe, c'est avoir le connecteur réel du propriétaire, et ne compte
 * pas. Lire les arguments d'un serveur d'impression ne dit pas non plus quel
 * fichier il imprime (revue de #777, passes 5 à 7) : seul le serveur qui le
 * reçoit le sait. Tant qu'elle n'existe pas, le besoin manque, toujours.
 */
export const BENCH_PRINTER_MISSING =
  "the bench's recording printer does not exist yet (#794): print trials never use a real printer, and only a printer that records what it received can tell which file was printed";

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
  'bench-printer'() {
    return BENCH_PRINTER_MISSING;
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

/** L'état de chaque besoin dans un environnement : là, ou la raison de son absence (Bench Studio). */
export function needReport(env: ScenarioEnv): Array<{ need: Need; missing: string | null }> {
  return NEED_IDS.map((need) => ({ need, missing: CHECKS[need](env) }));
}

// chat-or-work.ts — la frontière entre PARLER et PRODUIRE (plan « De la
// maquette au produit », P7).
//
// Un tour de conversation est du CHAT tant que rien n'en est sorti : lire,
// chercher, consulter et noter la mémoire, répondre en texte sur le canal de
// la conversation, confier une question à un sous-agent qui n'a fait que
// parler. Il devient du TRAVAIL dès qu'une trace reste ailleurs : un fichier,
// un envoi vers quelqu'un d'autre que l'interlocuteur, une commande, le
// harnais de code, une écriture dans une base externe.
//
// La frontière se lit sur les CARTES persistées par P1 (`tool_calls.card`,
// `presented`), jamais sur un nom d'outil natif — un nom se renomme, un
// connecteur tiers n'en a pas de reconnaissable, et une règle par nom serait
// exactement le pansement dans le runtime que l'invariant #3 interdit. Seule
// exception assumée : le préfixe `cli:`, qui n'est pas un nom d'outil mais un
// espace de noms — la marque du harnais de code, posée par l'enregistreur.
//
// Le seul cas que la carte ne tranche pas est le connecteur tiers : sa carte
// est `generic` pour une lecture comme pour une écriture. Son `risk_level`
// DÉCLARÉ (0095) le tranche ; quand il manque, la réponse est INCERTAINE et
// l'écran le dit — il n'invente pas un verdict (invariant #4).
//
// Deux choses ne sont JAMAIS une production, quelle que soit la carte : un
// appel dont l'issue n'est pas `success` (refusé, bloqué, en attente
// d'approbation, en erreur — la ligne existe quand même, avec la carte qu'il
// aurait remplie), et une ligne sans carte, d'avant P1. La première est du
// chat ; la seconde est INCONNUE, et se dit telle quelle (`unclassified`).
//
// Récursif sur les descendants : les lignes passées ici sont celles du job ET
// de toute sa descendance, à plat. Un sous-agent qui a écrit fait donc un
// encart sur le tour PARENT ; un sous-agent qui n'a fait que parler n'en fait
// aucun. La carte `delegation` elle-même ne compte pas — déléguer n'est pas
// produire — et `checks` non plus : la preuve est faite PAR le runner, sur ce
// qui a déjà été produit.

import { parsePresented, outcomeOfToolOutput } from './tool-card-payload.ts';

/** Une ligne `tool_calls`, réduite à ce que le classement lit. */
export type ClassifiableRow = {
  /** Le job qui a fait l'appel : celui de tête, ou l'un de ses descendants. */
  jobId: string | null;
  toolName: string;
  card: string | null;
  presented: unknown;
  /** 0095 — le niveau déclaré par l'outil. null : ligne d'avant, ou ligne `cli:*`. */
  riskLevel: string | null;
  toolInput: unknown;
  /**
   * La sortie brute, d'où se lit l'ISSUE de l'appel. Sans elle, un refus
   * d'approbation ou une erreur passait pour une production (revue Codex,
   * passe 29) : `executeTool` écrit la ligne dans TOUS les cas, y compris
   * quand rien n'est sorti.
   */
  toolOutput: string | null;
};

export type ProducedItem =
  | { kind: 'file'; label: string; path: string | null }
  | { kind: 'sent'; label: string }
  | { kind: 'command'; label: string }
  | { kind: 'harness'; label: string }
  | { kind: 'external'; label: string; certain: boolean };

export type ProductionVerdict = {
  isWork: boolean;
  items: ProducedItem[];
  /** Combien de classements reposent sur un risque NON déclaré. */
  uncertain: number;
  /** Combien de fichiers l'encart ne nomme pas (plafond). */
  more: number;
  /**
   * Les lignes SANS carte, hors `cli:*` : celles d'avant P1. L'absence de
   * carte ne prouve pas « chat » — elle prouve qu'on ne sait pas. L'écran le
   * dit d'un mot neutre, et ne fabrique jamais d'encart avec (revue Codex,
   * passe 29, doute 5).
   */
  unclassified: number;
};

/** Le plafond de fichiers nommés dans un encart — au-delà, il compte. */
export const PRODUCED_FILES_MAX = 8;

/** La commande, coupée : l'encart la reconnaît, il ne l'archive pas. */
const COMMAND_MAX = 80;

/**
 * Le harnais derrière une ligne `cli:*`. Le suffixe nomme le fournisseur
 * (`cli:claude-code`, `cli:codex`) sur la ligne du tour, et un outil INTERNE
 * au harnais (`cli:Edit`, `cli:Read`) sur les lignes vivantes — celles-là ne
 * disent pas quel harnais tournait. Le libellé générique est alors le seul
 * honnête : ce qui compte pour la frontière est qu'un harnais de code a
 * tourné, pas lequel.
 */
const HARNESS_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  claude: 'Claude Code',
  codex: 'Codex',
};
const HARNESS_FALLBACK = 'Code harness';

function harnessLabel(toolName: string): string {
  const suffix = toolName.slice(4).toLowerCase();
  return HARNESS_LABELS[suffix] ?? HARNESS_FALLBACK;
}

function truncate(text: string, max: number): string {
  const line = text.split('\n')[0] ?? text;
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function capitalize(text: string): string {
  return text === '' ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * Un envoi vers le canal DE LA CONVERSATION, à l'interlocuteur lui-même, est
 * une réponse : le canal est transparent, répondre sur Telegram à quelqu'un
 * qui écrit sur Telegram n'est pas plus « produire » que répondre dans le
 * dashboard. Une cible ABSENTE vaut l'interlocuteur — l'outil qui répond au
 * fil courant n'a personne d'autre à nommer.
 */
function sentIsReply(
  payload: { channel: string; target?: string },
  conversation: { channel: string; chatId: string | null },
): boolean {
  if (payload.channel.toLowerCase() !== conversation.channel.toLowerCase()) return false;
  if (payload.target === undefined || payload.target === '') return true;
  return conversation.chatId !== null && payload.target === conversation.chatId;
}

function sentLabel(payload: {
  channel: string;
  kind: string;
  target?: string;
  filename?: string;
}): string {
  if (payload.kind === 'message') {
    return payload.target ? `${payload.channel} to ${payload.target}` : payload.channel;
  }
  const what = payload.filename ?? payload.kind;
  const where = payload.target
    ? `${capitalize(payload.channel)} ${payload.target}`
    : capitalize(payload.channel);
  return `${what} to ${where}`;
}

/**
 * Ce que ces lignes ont fait sortir du chat.
 *
 * L'ordre des règles est celui du plan, et il compte : `cli:*` d'abord, parce
 * qu'un harnais de code écrit des lignes dont les cartes (`files`, `terminal`)
 * raconteraient l'histoire dix fois plutôt qu'une.
 */
export function classifyProduction(input: {
  conversation: { channel: string; chatId: string | null };
  /**
   * Les lignes `tool_calls` du job ET de tous ses descendants — plates : la
   * récursion est faite par l'appelant qui les charge.
   */
  rows: readonly ClassifiableRow[];
}): ProductionVerdict {
  const items: ProducedItem[] = [];
  const harnessSeen = new Set<string>();
  let uncertain = 0;
  let unclassified = 0;
  let files = 0;
  let more = 0;

  /** Un fichier de plus, ou un de plus à compter quand le plafond est atteint. */
  const pushFile = (label: string, path: string | null): void => {
    if (files >= PRODUCED_FILES_MAX) {
      more += 1;
      return;
    }
    files += 1;
    items.push({ kind: 'file', label, path });
  };

  for (const row of input.rows) {
    if (row.toolName.startsWith('cli:')) {
      // Le harnais compte même si SON appel a échoué : l'enregistreur vivant
      // écrit une ligne par outil INTERNE déjà exécuté, et ce qu'ils ont
      // touché est sur le disque quoi qu'il advienne du tour.
      const label = harnessLabel(row.toolName);
      if (!harnessSeen.has(label)) {
        harnessSeen.add(label);
        items.push({ kind: 'harness', label });
      }
      continue;
    }

    // L'ISSUE avant tout le reste. Un appel refusé, bloqué ou en attente
    // d'approbation n'a RIEN produit — sa ligne existe, et sa carte est celle
    // qu'il AURAIT remplie. La classer afficherait « Produced » pour une
    // écriture que le propriétaire vient justement de refuser.
    const outcome = outcomeOfToolOutput(row.toolOutput);
    if (outcome !== 'success') {
      // Une issue INCONNUE (aucune sortie enregistrée) ne prouve pas l'échec
      // non plus : elle est comptée comme non classable, jamais comme
      // production — même règle que les lignes sans carte.
      if (outcome === 'unknown') unclassified += 1;
      continue;
    }

    if (row.card === null) {
      // Une ligne d'avant P1 : ni carte ni charge. On ne sait pas.
      unclassified += 1;
      continue;
    }

    const payload = parsePresented(row.presented);

    if (row.card === 'files') {
      // Une charge absente ne prouve pas qu'il n'y a eu aucun fichier : la
      // carte est DÉCLARÉE par l'outil, seul son présentateur a manqué. On
      // compte l'écriture sans savoir laquelle. Une charge PRÉSENTE qui dit
      // zéro fichier, elle, tranche : rien n'est sorti.
      if (payload === null || payload.card !== 'files') {
        pushFile(row.toolName, null);
        continue;
      }
      if (payload.total === 0) continue;
      for (const f of payload.files) pushFile(f.path, f.path);
      // Le présentateur plafonne sa propre liste (`truncated`) : les fichiers
      // qu'il n'a pas nommés restent comptés.
      const named = payload.files.length;
      if (payload.total > named) more += payload.total - named;
      continue;
    }

    if (row.card === 'sent') {
      if (payload === null || payload.card !== 'sent') {
        // Un envoi dont on ne sait pas où il est parti : il est sorti du chat.
        items.push({ kind: 'sent', label: row.toolName });
        continue;
      }
      if (sentIsReply(payload, input.conversation)) continue;
      items.push({ kind: 'sent', label: sentLabel(payload) });
      continue;
    }

    if (row.card === 'terminal') {
      const label =
        payload !== null && payload.card === 'terminal'
          ? truncate(payload.command, COMMAND_MAX)
          : row.toolName;
      items.push({ kind: 'command', label });
      continue;
    }

    if (row.card === 'generic') {
      if (row.riskLevel === 'write' || row.riskLevel === 'destructive') {
        items.push({ kind: 'external', label: row.toolName, certain: true });
        continue;
      }
      if (row.riskLevel === 'read') continue;
      // Aucun risque déclaré : on ne sait pas. L'encart le dit, il ne tranche
      // pas — et cette ligne seule ne suffit pas à faire un travail.
      uncertain += 1;
      items.push({ kind: 'external', label: row.toolName, certain: false });
      continue;
    }

    // `text`, `read`, `search`, `table`, `checks`, `delegation`, `question` :
    // du chat.
  }

  // Un classement incertain ne DÉCIDE jamais qu'il y a eu travail — il n'est
  // dit que lorsque autre chose l'a déjà décidé.
  const isWork = items.some((i) => i.kind !== 'external' || i.certain);
  return { isWork, items, uncertain, more, unclassified };
}

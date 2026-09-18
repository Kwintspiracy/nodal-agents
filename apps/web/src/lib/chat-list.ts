// chat-list.ts — deux listes, pas une : les CANAUX et les conversations.
//
// POURQUOI. /chat mélangeait tout dans une seule liste triée par date. Sur la
// base de Quentin, le 08/09/2026, cela donnait 45 lignes pour son SEUL chat
// Telegram — une par conversation ouverte au fil des mois — noyant les dix
// conversations du dashboard. Et chacune portait pour titre le premier message
// de sa vie, si bien qu'un fil actif ce matin s'appelait encore « Fais-moi une
// app en HTML, en récupérant l'API de IGDB », écrit dix jours plus tôt.
//
// Les deux objets ne se ressemblent pas :
//   - un CHAT de canal ne se ferme jamais et ne se nettoie pas. Il n'est pas
//     nommé par ce qu'on y a dit en premier, mais par la personne ou le salon
//     à l'autre bout ;
//   - une conversation du dashboard est jetable : on l'ouvre d'un bouton, on la
//     supprime, l'IA la renomme.
//
// D'où une ligne PAR CHAT en haut — pas par canal : Telegram a un privé et des
// groupes, Discord plusieurs salons — et les conversations du dashboard en bas.

import type { ConversationListRow } from './conversation-actions.ts';

/** Un chat de canal, avec ce qui s'y passe en ce moment. */
export type ChannelChatRow = {
  /** `<canal>:<chatId>` — stable, et sans collision entre canaux. */
  key: string;
  channel: string;
  chatId: string;
  /**
   * Le nom du chat : la personne ou le salon à l'autre bout. Jamais un extrait
   * de message. `null` quand on ne le connaît pas — l'écran dit alors ce qu'il
   * sait, sans inventer.
   */
  name: string | null;
  /**
   * Sa nature — `private`, `group`, `channel`. Elle DISTINGUE : sur Discord et
   * Slack, l'allowlist enregistre le même `requester_name` pour le privé et
   * pour le salon d'une même personne, et deux lignes portaient donc le même
   * libellé (constaté à l'écran le 08/09).
   */
  kind: string | null;
  /**
   * Le fil COURANT de ce chat : celui qu'on ouvre en cliquant, désigné par la
   * base avec la règle du runner. `null` quand cette désignation manque — la
   * ligne s'affiche alors sans lien plutôt que d'en proposer un faux.
   */
  currentConversationId: string | null;
  /** Combien de fils ce chat a portés — 1 tant que personne n'a tapé `/new`. */
  conversationCount: number;
  agentName: string | null;
  agentSlug: string | null;
  agentAvatarUrl: string | null;
  updatedAt: Date | null;
  /** Le dernier mot de l'agent sur le fil courant. */
  lastPreview: string | null;
  /** Les tours du fil courant. */
  turns: number;
};

export type ChatLists = {
  channels: ChannelChatRow[];
  dashboard: ConversationListRow[];
  /** Au moins un chat n'a pas de fil courant désigné : l'écran doit le dire. */
  missingCurrent: boolean;
  /**
   * Des chats que la base connaît, mais dont AUCUNE conversation n'est entrée
   * dans la fenêtre de la liste (plafonnée). Ils n'ont donc pas de ligne — et
   * sans ce compte, ils disparaissaient sans que rien ne le signale (revue
   * Codex, PR #48, passe 8).
   */
  hiddenByWindow: number;
};

/**
 * Le nom d'un chat, tel que l'allowlist le connaît.
 *
 * Clé `<canal>:<chatId>`, valeur le nom déclaré par la personne à l'autre bout
 * — `requesterName`. Le propriétaire n'en a pas : c'est lui qui a branché le
 * bot, personne ne l'a « demandé ».
 */
export type ChatNames = Readonly<Record<string, { name: string | null; kind: string | null }>>;

// La clé d'un chat vit dans son PROPRE module : l'action qui interroge la base
// en a besoin autant que ce regroupement, et l'importer d'ici créait un cycle
// (chat-list → conversation-actions → chat-list) que dependency-cruiser refuse,
// `import type` ou non. Réexportée pour que rien ne change à l'usage.
import { chatKey } from './chat-key.ts';
export { chatKey };

/** Les canaux où « #salon » est la convention que l'utilisateur lit ailleurs. */
const HASH_CHANNELS = new Set(['discord', 'slack']);

/**
 * Le nom d'un chat sur une ligne : la personne ou le salon à l'autre bout.
 *
 * Vit ici, et non dans un écran, depuis #135 : le tableau de la page entière
 * et la LIGNE d'un dossier nomment le même chat, et deux copies de cette règle
 * auraient fini par le nommer différemment.
 *
 * Sans nom connu, on dit ce qu'on SAIT. « Direct » n'est vrai que pour un chat
 * dont on connaît la nature privée — c'est le cas du PROPRIÉTAIRE, qui a
 * branché le bot lui-même et que personne n'a « demandé » ; l'écrire par défaut
 * rendait indistinguables tous les chats anonymes (revue Codex, PR #48).
 */
export function chatLabel(
  // Ce que le NOM demande, et rien de plus : le canal, l'interlocuteur, le nom
  // qu'on lui connaît et sa nature. Une ligne entière convient toujours ; le
  // sous-menu de la barre latérale, lui, ne lit que ces quatre colonnes et n'a
  // aucune raison d'en fabriquer d'autres pour appeler cette fonction.
  row: Pick<ChannelChatRow, 'channel' | 'chatId' | 'name' | 'kind'>,
): string {
  const salon = row.kind === 'channel' || row.kind === 'group';
  if (row.name !== null && row.name !== '') {
    // Le `#` distingue un salon d'un privé : sur Discord et Slack, l'allowlist
    // enregistre le même nom pour les deux, et deux lignes se ressemblaient
    // trait pour trait. Ailleurs il ne se dit pas — un groupe Telegram ne
    // s'écrit pas « #groupe » (revue Codex, PR #48).
    return salon && HASH_CHANNELS.has(row.channel) ? `#${row.name}` : row.name;
  }
  if (row.kind === 'private') return 'Direct';
  return salon ? `Group ${row.chatId}` : row.chatId;
}

/**
 * Sépare les fils de canal des conversations du dashboard, et replie les
 * premiers par chat.
 *
 * Une ligne de chat porte DEUX temps, et les confondre était le défaut :
 *   - sa RÉCENCE est celle du chat — le maximum des `updated_at`, donc la
 *     première ligne reçue, puisque l'action trie par `updated_at DESC`. Un
 *     fil ancien qu'on remue a bel et bien fait bouger ce chat ;
 *   - son FIL COURANT est celui que la BASE désigne (`currentByChat`), et c'est
 *     lui qu'on ouvre au clic. Son aperçu et ses tours le suivent : la ligne
 *     dirait sinon le dernier mot d'un autre fil que celui vers lequel elle
 *     mène.
 *
 * Cette fonction ne DEVINE jamais le fil courant. Elle l'a fait deux passes
 * durant, et s'est trompée les deux fois — la règle vit en SQL, sur des données
 * entières et des timestamps que JavaScript tronque. Sans désignation, la ligne
 * n'a pas de lien et `missingCurrent` le dit : une estimation présentée comme
 * un fait est précisément le repli silencieux qu'interdit l'invariant #4.
 *
 * Les fils non courants ne servent qu'à compter — ils restent lisibles par
 * leur URL, ils ne méritent pas une ligne de liste.
 *
 * Une conversation de canal sans `chatId` ne peut être ratachée à aucun chat :
 * elle reste dans la liste du bas plutôt que de disparaître.
 */
export function groupChatLists(
  rows: readonly ConversationListRow[],
  names: ChatNames = {},
  currentByChat: Readonly<Record<string, string>> = {},
  /**
   * Les chats ÉLIGIBLES à la liste. Par défaut, ceux qui ont une désignation —
   * ce qui convient à un test unitaire pur, mais PAS à la page : un chat peut
   * être désigné sans être listable (son seul fil est un entretien d'accueil),
   * et le compter comme manquant ferait dire à l'écran qu'un plafond l'a
   * écarté, ce qui serait faux.
   */
  listableChats: readonly string[] = Object.keys(currentByChat),
): ChatLists {
  const channels = new Map<string, ChannelChatRow>();
  const dashboard: ConversationListRow[] = [];
  /** Les chats dont la base n'a désigné aucun fil courant. */
  const sansDesignation = new Set<string>();

  for (const r of rows) {
    if (r.channel === 'dashboard' || r.chatId === null || r.chatId === '') {
      dashboard.push(r);
      continue;
    }
    const key = chatKey(r.agentId, r.channel, r.chatId);
    const nameKey = `${r.channel}:${r.chatId}`;
    // La BASE a désigné le fil courant de ce chat, ou personne ne l'a fait.
    // Il n'y a PAS de troisième voie : reconstituer une estimation ici, c'était
    // le repli silencieux que la passe 7 a refusé (invariant #4). Une ligne qui
    // n'est pas le fil désigné ne prend jamais sa place, même si elle arrive en
    // premier ou paraît plus récente.
    const designe = currentByChat[key];
    if (designe === undefined) sansDesignation.add(key);
    const seen = channels.get(key);
    if (seen) {
      seen.conversationCount += 1;
      if (designe !== undefined && r.id === designe) {
        seen.currentConversationId = r.id;
        seen.lastPreview = r.lastPreview;
        seen.turns = r.turns;
      }
      continue;
    }
    channels.set(key, {
      key,
      channel: r.channel,
      chatId: r.chatId,
      // Le NOM se cherche par (canal, chat) : l'allowlist nomme l'interlocuteur,
      // qui est le même quel que soit l'agent qui lui parle.
      name: names[nameKey]?.name ?? null,
      kind: names[nameKey]?.kind ?? null,
      // Le fil désigné, même s'il n'est PAS dans les lignes chargées : la
      // fenêtre de la liste peut l'avoir laissé dehors, et le lien doit mener
      // là où ira le prochain message, pas au fil le plus visible. `null` quand
      // la base n'a rien désigné — l'écran le DIT au lieu de deviner.
      currentConversationId: designe ?? null,
      conversationCount: 1,
      agentName: r.agentName,
      agentSlug: r.agentSlug,
      agentAvatarUrl: r.agentAvatarUrl,
      updatedAt: r.updatedAt,
      // L'aperçu et les tours décrivent le fil COURANT. Tant qu'on n'a pas
      // rencontré sa ligne, on ne les invente pas : une ligne muette est plus
      // vraie que le dernier mot d'un autre fil.
      lastPreview: designe === r.id ? r.lastPreview : null,
      turns: designe === r.id ? r.turns : 0,
    });
  }

  // Les chats listables qui n'ont AUCUNE ligne. On les compte un par un, on ne
  // soustrait pas deux tailles : les deux lectures ne sont pas atomiques, et un
  // chat créé entre elles compensait exactement un chat manquant — 1 − 1 = 0,
  // et le silence redevenait invisible (revue Codex, PR #48, passe 9).
  const hiddenByWindow = listableChats.filter((k) => !channels.has(k)).length;

  return {
    channels: [...channels.values()],
    dashboard,
    hiddenByWindow,
    // L'écran doit pouvoir DIRE qu'il ne sait pas, plutôt que d'ouvrir un fil
    // au jugé. Une désignation manquante n'est pas une conversation absente :
    // c'est une lecture qui a échoué, et ça se montre.
    missingCurrent: sansDesignation.size > 0,
  };
}

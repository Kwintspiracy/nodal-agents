// chat-folders.ts — le menu Chat de la barre latérale (#135).
//
// « Chat » n'est plus un lien mais un GROUPE : un dossier par endroit d'où les
// conversations arrivent — un par canal branché, et « Nodal chats » pour
// celles ouvertes ici. PAS de dossier « Routines » : une automation n'est pas
// un dialogue, personne n'y parle à un agent (Quentin, 17/09/2026). Les runs
// programmés ont leur page, Scheduled, et leurs demandes en attente restent
// sur /approvals.
//
// Chaque dossier porte DEUX signaux, et tout l'intérêt est de ne pas les
// confondre :
//
//   - la PASTILLE corail compte ce qui ATTEND LA PERSONNE. C'est un nombre
//     qu'elle peut faire tomber à zéro en répondant. Elle est cachée à zéro :
//     une pastille « 0 » demande de la lire pour apprendre qu'il n'y a rien.
//   - le POINT vert dit qu'un run TOURNE. Ce n'est pas du travail pour elle,
//     et il ne porte JAMAIS de nombre : deux chiffres côte à côte, l'un
//     d'attentes et l'autre de runs, ne se lisent plus.
//
// ⚠️ CE QUI N'EST PAS COMPTÉ, et pourquoi. La base ne porte AUCUN état de
// lecture — pas de `last_read_at`, nulle part. Une réponse d'agent non lue
// n'est donc pas comptable, et elle n'est pas comptée : inventer un état de
// lecture ici ferait dire à la pastille un chiffre que rien ne peut vérifier
// (invariant #4). Même chose pour « un livrable à vérifier » : aucune colonne
// ne dit qu'un livrable attend un œil. Le jour où l'une des deux existe, elle
// s'ajoute à `waiting` sans rien changer d'autre.

import { LIVE_JOB_STATUSES } from '@nodal-agents/shared';
import { CHANNEL_LABELS } from './activity-runs.ts';

/** Le dossier des conversations ouvertes dans Nodal même. */
export const DASHBOARD_FOLDER = 'dashboard';

/**
 * Le dossier des runs lancés depuis DEHORS — une requête à `/api/agent`, un
 * appel du serveur MCP (Quentin, 18/09/2026).
 *
 * Ces runs n'ont pas de conversation : personne ne leur parle, une machine les
 * demande et lit leur résultat. Ils n'apparaissaient qu'en marge de `/code`,
 * sous « Other sessions ». Ils ont leur propre entrée, au même endroit que les
 * canaux : c'est bien un endroit d'où le travail arrive.
 *
 * ⚠️ CE QUE LES ANCIENNES LIGNES NE DISENT PAS. `agent_jobs.channel` valait
 * `api` pour une requête extérieure ET pour la boîte « Send task » du tableau
 * de bord : Quentin a ouvert le dossier le 18/09 et y a trouvé des runs « qui
 * ne viennent pas du MCP ». Corrigé à la SOURCE — `sendTaskAction` écrit
 * `dashboard` (apps/web/src/lib/actions.ts) — et non par un filtre ici, qui
 * n'aurait fait que deviner.
 *
 * Les lignes DÉJÀ écrites gardent `api` et restent indiscernables : le dossier
 * montre donc encore les anciennes tâches « Send task », jusqu'à ce qu'elles
 * sortent de la liste. Les réécrire leur inventerait une provenance que rien
 * ne vérifie (invariant #4).
 */
export const MCP_FOLDER = 'mcp';

/**
 * Les canaux d'un job qui rangent son travail dans le dossier MCP. Exportés :
 * la lecture qui compte et liste ces runs doit filtrer sur EXACTEMENT les
 * mêmes valeurs que la règle d'attribution, sinon le dossier existe sans rien
 * lister, ou l'inverse.
 */
export const MCP_JOB_CHANNELS: readonly string[] = ['api', MCP_FOLDER];

/**
 * L'ordre des dossiers de canal. Celui de la maquette — pas l'ordre
 * alphabétique, ni celui où la base rend ses lignes, qui changerait d'un
 * chargement à l'autre.
 */
const CHANNEL_ORDER: readonly string[] = ['telegram', 'slack', 'discord', 'whatsapp'];

/**
 * Les statuts qui font TOURNER un run, donc allumer le point vert.
 *
 * DÉRIVÉS de la liste du produit (`LIVE_JOB_STATUSES`) moins
 * `awaiting_approval` : un run arrêté sur une approbation n'avance pas, il
 * attend la personne — et c'est déjà ce que dit la pastille. Les afficher tous
 * les deux ferait porter à chaque dossier en attente un point qui répète la
 * pastille sans rien ajouter.
 *
 * Écrits par soustraction, jamais recopiés : un statut vivant ajouté demain
 * allume le point sans que personne n'y pense.
 */
export const RUNNING_JOB_STATUSES: readonly string[] = LIVE_JOB_STATUSES.filter(
  (s) => s !== 'awaiting_approval',
);

/**
 * Le dossier auquel appartient le travail d'un job, lu sur SON CANAL.
 *
 * `null` quand le job ne relève d'aucun dossier du menu Chat — `internal` (un
 * agent qui en appelle un autre), `webhook`, `task-board`, `cron`. Ce
 * travail-là reste entier sur `/approvals` ; il n'est simplement rangé dans
 * aucun dossier de chat, et aucun chiffre ne le compte deux fois.
 *
 * `api` et `mcp` rangent tous les deux dans le dossier MCP depuis le 18/09 :
 * ce sont les deux valeurs qu'écrit une demande venue de dehors, et elles
 * désignent le même endroit pour qui regarde le menu.
 */
export function folderOfJobChannel(channel: string | null): string | null {
  if (channel === null || channel === '') return null;
  // Une automation n'a pas de dossier : elle n'est pas un endroit où l'on parle.
  if (channel === 'cron') return null;
  if (channel === 'dashboard') return DASHBOARD_FOLDER;
  if (MCP_JOB_CHANNELS.includes(channel)) return MCP_FOLDER;
  if (CHANNEL_ORDER.includes(channel)) return channel;
  return null;
}

/**
 * D'où vient un travail, tel que l'attribution le lit : le canal de son job, et
 * celui de sa CONVERSATION quand il en a une.
 */
export type WorkOrigin = {
  /** Le canal du job lui-même. */
  jobChannel: string | null;
  /**
   * Le canal de la conversation du job. `null` quand le job ne se rattache à
   * aucune conversation — une tâche de l'API, une automation.
   */
  conversationChannel: string | null;
  /**
   * Le canal du job de TÊTE de la chaîne — celui que personne n'a délégué.
   * Lu seulement quand le job lui-même ne désigne aucun dossier, et absent
   * (`undefined`) quand l'appelant ne l'a pas résolu.
   *
   * Pourquoi il existe (18/09). Un délégué d'un run venu de dehors porte
   * `channel = 'internal'` et AUCUNE conversation — son parent n'en a pas
   * (packages/orchestration/src/router/delegate.ts). Sa question n'était donc
   * comptée nulle part : le dossier MCP restait muet pendant qu'un run y
   * attendait une réponse. Le canal de tête est la seule chose en base qui dit
   * d'où cette chaîne est partie.
   *
   * `null` quand la chaîne n'a pas pu être remontée — un maillon manquant ne
   * devient jamais une supposition (invariant #4).
   */
  rootChannel?: string | null;
};

/**
 * Le dossier auquel appartient un travail : celui du canal de SA CONVERSATION
 * quand il en a une, celui de son propre canal sinon.
 *
 * **Pourquoi la conversation d'abord** (#148). Un job délégué que le tableau
 * des tâches crée porte `channel = 'task-board'` et le `conversation_id` de son
 * créateur. Lu sur son canal, il ne relève d'aucun dossier : la LIGNE de la
 * conversation s'allumait — elle attribue par `conversation_id` — pendant que
 * la pastille du dossier, son sous-titre et le total du menu comptaient zéro.
 * Un dossier muet au-dessus d'une ligne qui dit « Question asked ».
 *
 * Le canal d'une conversation est l'endroit d'où la personne parle ; celui d'un
 * job dit seulement quelle mécanique l'a lancé. C'est le premier qui range le
 * travail, et la ligne et le dossier comptent de nouveau la MÊME chose.
 *
 * Le canal du job reste la règle pour un travail SANS conversation : il n'y a
 * alors rien d'autre à lire, et lui choisir un dossier serait l'inventer
 * (invariant #4).
 */
export function folderOfWork(origin: WorkOrigin): string | null {
  const conv = origin.conversationChannel;
  if (conv !== null && conv !== '') return folderOfJobChannel(conv);
  const own = folderOfJobChannel(origin.jobChannel);
  if (own !== null) return own;
  // EN DERNIER, et jamais avant : le canal de tête ne sert qu'au travail que
  // ni sa conversation ni son propre canal ne rangent. Le lire plus tôt ferait
  // remonter un délégué au dossier de son parent alors qu'il porte lui-même un
  // canal qui a un dossier — deux règles pour le même cas.
  return folderOfJobChannel(origin.rootChannel ?? null);
}

/** Le nom d'un dossier. Un canal inconnu se rend TEL QUEL, comme la colonne
 *  « d'où vient la demande » le fait : un canal ajouté demain doit s'afficher,
 *  pas disparaître. */
export function folderLabel(key: string): string {
  if (key === DASHBOARD_FOLDER) return 'Nodal chats';
  return CHANNEL_LABELS[key] ?? key;
}

/** Où mène un dossier : `/chat`, filtré sur lui. */
export function folderHref(key: string): string {
  return `/chat?folder=${encodeURIComponent(key)}`;
}

export type ChatFolder = {
  /** L'identité du dossier — et la valeur de `folder=` dans l'URL. */
  key: string;
  label: string;
  href: string;
  /** Ce qui attend la personne ici. 0 = pas de pastille du tout. */
  waiting: number;
  /** Un run tourne ici. Un booléen, jamais un compte. */
  running: boolean;
  active: boolean;
};

export type ChatFoldersInput = {
  /** Les canaux qui portent au moins une conversation (lus en base). */
  channels: readonly string[];
  /**
   * Une entrée par demande en attente, avec d'où elle vient : le canal de sa
   * conversation quand elle en a une, celui de son job sinon (`folderOfWork`).
   */
  waiting: readonly WorkOrigin[];
  /** Combien de runs tournent, par dossier. Une clé absente vaut zéro. */
  running: Readonly<Record<string, number>>;
  /**
   * Combien de runs de TÊTE viennent de dehors — c'est ce qui fait EXISTER le
   * dossier MCP, exactement comme une conversation fait exister le dossier
   * d'un canal. Zéro : pas de dossier du tout, plutôt qu'un dossier vide dont
   * rien n'expliquerait la présence.
   */
  externalRuns: number;
  /** Le chemin courant : un dossier n'est actif que SUR . */
  pathname: string;
  /** Le `folder=` de l'URL, pour l'état actif des dossiers de chat. */
  folderParam: string | null;
};

/**
 * Quels dossiers EXISTENT, dans l'ordre où ils s'affichent.
 *
 * Un canal sans conversation n'a pas de dossier — la maquette montre les
 * endroits où l'on parle, pas le catalogue des canaux que le produit sait
 * brancher. Mais un canal qui porte du travail EN ATTENTE ou un run qui tourne
 * a son dossier même si aucune conversation n'a été lue : sans cela, une
 * approbation aurait disparu du menu en silence, et son compte avec elle
 * (invariant #4).
 *
 * « Nodal chats » est TOUJOURS là : c'est une destination permanente du
 * produit — la page existe, vide ou non — et la faire apparaître et
 * disparaître ferait bouger le menu sous le curseur.
 */
function existingKeys(
  input: Pick<ChatFoldersInput, 'channels' | 'waiting' | 'running' | 'externalRuns'>,
): string[] {
  const chan = new Set<string>();
  for (const c of input.channels) {
    const key = folderOfJobChannel(c);
    // Une conversation du dashboard ne « crée » pas le dossier Nodal chats :
    // il est de toute façon là. Le dossier MCP non plus : il tient à des RUNS,
    // pas à des conversations, et `externalRuns` est le seul chiffre qui le
    // dit. Les autres canaux, oui.
    if (key !== null && key !== DASHBOARD_FOLDER && key !== MCP_FOLDER) chan.add(key);
  }
  for (const w of input.waiting) {
    const key = folderOfWork(w);
    if (key !== null && key !== DASHBOARD_FOLDER) chan.add(key);
  }
  for (const [key, count] of Object.entries(input.running)) {
    if (count > 0 && key !== DASHBOARD_FOLDER) chan.add(key);
  }
  if (input.externalRuns > 0) chan.add(MCP_FOLDER);
  const known = CHANNEL_ORDER.filter((c) => chan.has(c));
  // Un canal que la maquette ne connaît pas se range après, par ordre
  // alphabétique — un ordre stable, plutôt que celui de la base.
  const unknown = [...chan].filter((c) => !CHANNEL_ORDER.includes(c) && c !== MCP_FOLDER).sort();
  // « Nodal chats » EN TÊTE (Quentin, 18/09) : c'est le dossier où l'on parle
  // depuis le dashboard, celui qu'on ouvre le plus ; les canaux suivent, dans
  // l'ordre de la maquette, puis ceux qu'elle ne connaît pas. MCP FERME la
  // liste : ce n'est pas un canal qu'on branche, c'est ce qui arrive quand
  // personne ne parle — sa place est au bout, pas au milieu des messageries.
  const mcp = chan.has(MCP_FOLDER) ? [MCP_FOLDER] : [];
  return [DASHBOARD_FOLDER, ...known, ...unknown, ...mcp];
}

/** Ce qui attend la personne, rangé par dossier. */
function waitingByFolder(waiting: ChatFoldersInput['waiting']): Map<string, number> {
  const byFolder = new Map<string, number>();
  for (const w of waiting) {
    const key = folderOfWork(w);
    if (key === null) continue;
    byFolder.set(key, (byFolder.get(key) ?? 0) + 1);
  }
  return byFolder;
}

/**
 * Un dossier est ACTIF quand l'URL le désigne : le `folder=` de `/chat`. Sur
 * `/scheduled`, aucun ne l'est : Scheduled a son propre lien dans le menu.
 *
 * Un fil ouvert (`/chat/<id>`) ne rallume aucun dossier : rien dans son URL ne
 * dit d'où il vient, et deviner le rendrait faux une fois sur deux.
 */
function isFolderActive(key: string, pathname: string, folderParam: string | null): boolean {
  return pathname === '/chat' && folderParam === key;
}

/** Les lignes du groupe « Chat folders », prêtes à rendre. */
export function chatFolders(input: ChatFoldersInput): ChatFolder[] {
  const byFolder = waitingByFolder(input.waiting);
  return existingKeys(input).map((key) => ({
    key,
    label: folderLabel(key),
    href: folderHref(key),
    waiting: byFolder.get(key) ?? 0,
    running: (input.running[key] ?? 0) > 0,
    active: isFolderActive(key, input.pathname, input.folderParam),
  }));
}

/**
 * Le compte que porte le lien « Chat » lui-même : le total de ce qui attend la
 * personne dans ses dossiers de chat.
 *
 * Il se calcule sur les MÊMES dossiers que le groupe en dessous — la somme des
 * pastilles, à la lettre. Un total qui compterait une attente sans dossier
 * serait un chiffre que rien à l'écran ne justifie.
 */
export function chatWaitingTotal(
  input: Pick<ChatFoldersInput, 'channels' | 'waiting' | 'running' | 'externalRuns'>,
): number {
  const byFolder = waitingByFolder(input.waiting);
  return existingKeys(input).reduce((sum, key) => sum + (byFolder.get(key) ?? 0), 0);
}

// ─── Les derniers fils d'un dossier (18/09/2026) ─────────────────────────────
//
// Un dossier se DÉPLIE : son chevron montre ses derniers fils, et « See all »
// mène à sa liste entière. Ce ne sont pas d'autres lignes que celles de la
// liste — ce sont LES MÊMES, coupées aux premières. Le titre est donc celui
// que la lecture a déjà écrit : masqué (#179) et borné à sa source, jamais
// reconstruit ici.

/** Une entrée du sous-menu d'un dossier : un fil, et où il mène. */
export type FolderThread = {
  /** L'identité de la ligne — sa clé de rendu et son `data-testid`. */
  key: string;
  /** Le titre, tel que la LISTE du dossier l'écrit. */
  title: string;
  /** Où mène la ligne : un fil (`/chat/<id>`) ou un run (`/jobs/<id>`). */
  href: string;
  /**
   * Quelque chose ATTEND LA PERSONNE sur ce fil : une approbation, une
   * question. Exactement ce que compte la pastille du dossier, lu au niveau du
   * FIL plutôt qu'à celui du dossier — la même lecture, la même règle.
   */
  waiting: boolean;
  /** Un run TOURNE sur ce fil. La même donnée que le point vert du dossier. */
  running: boolean;
};

/** Une ligne de liste, avec le dossier où elle se range. */
export type FolderThreadSource = FolderThread & { folder: string };

/**
 * Le point d'un fil doit-il APPELER la personne ?
 *
 * Oui dès qu'il y a de quoi revenir : une demande en attente, ou un run qui
 * tourne. Rien d'autre.
 *
 * ⚠️ CE N'EST PAS « NON LU ». La base ne porte AUCUN état de lecture — pas de
 * `last_read_at`, nulle part — et c'est une décision (17/09/2026), pas un
 * oubli. Peindre en rouge un fil « non lu » afficherait un fait que rien ne
 * peut vérifier (invariant #4). Le jour où la colonne existe, elle s'ajoute
 * ici, et le point voudra dire une chose de plus.
 */
export function threadCallsFor(thread: Pick<FolderThread, 'waiting' | 'running'>): boolean {
  return thread.waiting || thread.running;
}

/**
 * Combien de fils un sous-menu déplie.
 *
 * Cinq (Quentin, 18/09/2026). Assez pour retrouver ce qu'on a ouvert ce
 * matin ; pas assez pour que la barre latérale devienne la liste, qui a sa
 * page et son bouton « See all ».
 */
export const FOLDER_THREADS_MAX = 5;

/**
 * Les derniers fils de CHAQUE dossier, dans l'ordre reçu.
 *
 * L'ordre est celui de la lecture — le plus récent d'abord — et il n'est pas
 * retrié ici : le sous-menu doit montrer exactement la tête de la liste que
 * « See all » ouvre, sinon les deux se contredisent sous le même nom.
 *
 * Un dossier absent de la table n'a rien à déplier ; c'est l'appelant qui
 * décide de ce qu'il en dit.
 */
export function folderThreads(
  rows: readonly FolderThreadSource[],
  max: number = FOLDER_THREADS_MAX,
): Record<string, FolderThread[]> {
  const byFolder: Record<string, FolderThread[]> = {};
  for (const r of rows) {
    const ligne: FolderThread = {
      key: r.key,
      title: r.title,
      href: r.href,
      waiting: r.waiting,
      running: r.running,
    };
    const seen = byFolder[r.folder];
    if (seen === undefined) {
      byFolder[r.folder] = [ligne];
      continue;
    }
    // On CONTINUE de parcourir plutôt que de s'arrêter : les lignes arrivent
    // mêlées, tous dossiers confondus, et le cinquième fil de Telegram peut
    // très bien précéder le premier de Slack.
    if (seen.length >= max) continue;
    seen.push(ligne);
  }
  return byFolder;
}

// folder-view.ts — ce que `/chat?folder=…` montre, et ce qu'il en dit (#135).
//
// La page reste la même liste ; le dossier n'en est qu'une VUE. Deux décisions
// pures, donc testables sans navigateur :
//   - ce qui s'affiche — un canal, les conversations de Nodal, ou tout ;
//   - la phrase sous le titre, qui ne dit QUE des chiffres non nuls.
//
// Un `folder=` inconnu ne filtre RIEN et ne renomme rien : la page redevient la
// page complète. Montrer « 0 conversation » sous un nom de dossier inventé
// ferait croire à un dossier vide là où il n'y a pas de dossier du tout.

import { DASHBOARD_FOLDER, folderLabel, MCP_FOLDER } from '@/lib/chat-folders.ts';

export type ChatFolderView = {
  /** Le dossier retenu, ou `null` quand l'URL n'en désigne aucun de valide. */
  key: string | null;
  /** Le titre de la page — le nom du dossier, ou « Chat ». */
  title: string;
  /** Le canal dont on garde les chats. `null` = tous. */
  channel: string | null;
  /** La table des chats de canal s'affiche-t-elle ? */
  showChannels: boolean;
  /** La liste des conversations de Nodal s'affiche-t-elle ? */
  showDashboard: boolean;
  /**
   * La liste des RUNS venus de dehors s'affiche-t-elle ? Le dossier MCP est le
   * seul qui ne liste pas des conversations : ces runs n'en ont aucune.
   */
  showRuns: boolean;
};

const FULL_VIEW: ChatFolderView = {
  key: null,
  title: 'Channels',
  channel: null,
  showChannels: true,
  showDashboard: true,
  showRuns: false,
};

/**
 * La vue que demande l'URL.
 *
 * `channels` est la liste des canaux que la BASE connaît : un `folder=` qui
 * n'en fait pas partie n'est pas un dossier, quelle que soit son allure. Sans
 * cette vérification, `?folder=nimportequoi` donnait une page vide intitulée
 * « Nimportequoi ».
 */
export function chatFolderView(
  folderParam: string | null,
  channels: readonly string[],
): ChatFolderView {
  if (folderParam === null || folderParam === '') return FULL_VIEW;
  if (folderParam === DASHBOARD_FOLDER) {
    return {
      key: DASHBOARD_FOLDER,
      title: folderLabel(DASHBOARD_FOLDER),
      channel: null,
      showChannels: false,
      showDashboard: true,
      showRuns: false,
    };
  }
  // Le dossier MCP est valide SANS passer par `channels` : il ne tient pas à
  // une conversation mais à des runs, et la page les lit elle-même. Sa liste
  // vide dit alors « aucun run venu de dehors », ce qui est vrai — tandis que
  // rendre la page entière ferait disparaître un dossier que le menu propose.
  if (folderParam === MCP_FOLDER) {
    return {
      key: MCP_FOLDER,
      title: folderLabel(MCP_FOLDER),
      channel: null,
      showChannels: false,
      showDashboard: false,
      showRuns: true,
    };
  }
  // Un `folder=` que le menu ne propose pas (une valeur tapée à la main, un
  // canal sans conversation) rend la page entière, jamais une vue vide.
  if (!channels.includes(folderParam)) return FULL_VIEW;
  return {
    key: folderParam,
    title: folderLabel(folderParam),
    channel: folderParam,
    showChannels: true,
    showDashboard: false,
    showRuns: false,
  };
}

export type FolderCounts = {
  /** Ce que le dossier LISTE — des conversations partout, des runs sur MCP. */
  conversations: number;
  /** Ce qui attend la personne dans ce dossier. */
  waiting: number;
  /** Les runs qui tournent dans ce dossier. */
  running: number;
};

/**
 * La phrase sous le titre d'un dossier : « 3 conversations · 1 waiting for you
 * · 2 running ».
 *
 * Chaque morceau DISPARAÎT à zéro — « 0 waiting for you » demande d'être lu
 * pour apprendre qu'il n'y a rien. Tout à zéro rend `null` : la page n'affiche
 * alors aucune phrase, plutôt qu'une phrase vide ou un texte inventé sur ce
 * que le dossier deviendra.
 *
 * `noun` nomme ce que le dossier liste. Le dossier MCP dit « 3 runs » : y
 * écrire « conversations » nommerait ce que ces lignes ne sont pas.
 */
export function folderSubtitle(counts: FolderCounts, noun = 'conversation'): string | null {
  const parts: string[] = [];
  if (counts.conversations > 0) {
    parts.push(`${counts.conversations} ${counts.conversations === 1 ? noun : `${noun}s`}`);
  }
  if (counts.waiting > 0) parts.push(`${counts.waiting} waiting for you`);
  if (counts.running > 0) parts.push(`${counts.running} running`);
  return parts.length === 0 ? null : parts.join(' · ');
}

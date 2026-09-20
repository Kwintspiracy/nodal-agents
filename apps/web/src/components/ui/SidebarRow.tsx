'use client';

// SidebarRow — LA ligne du rail, et il n'y en a qu'une (Quentin, 19/09/2026).
//
// Pourquoi ce fichier existe. Le rail portait quatre formes de ligne : une
// entrée de menu (48 px, coins `xl`), un dossier de Channels (40 px, coins
// `lg`, retrait de 28 px), un fil déplié, un « See all ». Elles ne se
// survolaient pas pareil, ne s'allumaient pas pareil, et depuis que certaines
// ont gagné un chevron, le fond de survol s'arrêtait AVANT le chevron : on
// voyait la ligne s'éclairer à moitié.
//
// Une ligne = un CONTENEUR qui porte la forme et l'état, un LIEN qui le
// remplit, et, quand il y en a un, un chevron FRÈRE du lien. Frère, et non
// dedans : un `<button>` ne peut pas vivre dans un `<a>`. Le survol est sur le
// conteneur, donc il couvre le lien ET la zone du chevron, d'un bord à
// l'autre.
//
// Ce qui varie d'une ligne à l'autre est la PROFONDEUR — le retrait à gauche,
// qui dit ce qui est dans quoi — et jamais la forme. C'est la seule chose que
// `depth` règle.

import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * La forme d'une ligne : marges, hauteur, rayon. Identique pour toutes.
 *
 * Exportée parce qu'un test la compare d'une ligne à l'autre : c'est ce qui
 * fait de « toutes les lignes se ressemblent » une chose vérifiable, et pas
 * une intention dans un commentaire.
 */
export const SIDEBAR_ROW_BASE =
  'group flex w-full items-center rounded-xl transition-colors lg:rounded-lg';

/**
 * La HAUTEUR d'une ligne, par profondeur. Elle est à part parce que c'est la
 * SEULE chose que les planches de Quentin (19/09/2026) font varier : 30 px
 * pour une entrée de menu, un dossier ou le fil d'un dossier, 28 px pour un
 * fil de la section « Recent », qui est une liste de rappel et non une
 * destination.
 *
 * Sur mobile, toutes montent à 48 px : un doigt ne vise pas 28 px.
 */
export const SIDEBAR_ROW_H: Record<SidebarDepth, string> = {
  nav: 'h-12 lg:h-[30px]',
  folder: 'h-12 lg:h-[30px]',
  // 28 px depuis le 20/09 (planche 25:1062) : une ligne de CONTENU — un fil,
  // un projet, un agent — est plus basse qu'une entrée de menu, comme celles
  // de « Recent » l'étaient déjà.
  thread: 'h-12 lg:h-7',
  recent: 'h-12 lg:h-7',
};

/** La forme d'une ligne de menu — la plus courante, et le défaut des notes. */
export const SIDEBAR_ROW = `${SIDEBAR_ROW_BASE} ${SIDEBAR_ROW_H.nav}`;

/**
 * La ligne ACTIVE : fond papier et ombre légère, donc « en relief » quel que
 * soit le thème. C'était le traitement des entrées de menu ; les dossiers en
 * avaient un autre (`bg-hover`), qui les faisait ressembler à une ligne
 * survolée plutôt qu'à la ligne où l'on est.
 */
export const SIDEBAR_ROW_ACTIVE = 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]';

/** La ligne au repos, et son survol. */
export const SIDEBAR_ROW_IDLE = 'text-ink-2 hover:bg-hover';

/**
 * Une ligne de CONTENU au repos : le gris d'un cran plus loin (`ink-3`). La
 * planche 25:1062 (20/09) écrit les entrées de menu en `ink-2` Medium 13 et
 * ce qu'elles contiennent — fils, projets, agents — en `ink-3` Regular 12 :
 * deux couleurs de police, et c'est ce qui sépare le menu de son contenu.
 */
export const SIDEBAR_ROW_IDLE_CONTENT = 'text-ink-3 hover:bg-hover hover:text-ink-2';

/** La classe complète d'une ligne — forme, hauteur, puis état. Dans cet ordre. */
export function sidebarRowClass(active = false, depth: SidebarDepth = 'nav'): string {
  const idle =
    depth === 'thread' || depth === 'recent' ? SIDEBAR_ROW_IDLE_CONTENT : SIDEBAR_ROW_IDLE;
  return `${SIDEBAR_ROW_BASE} ${SIDEBAR_ROW_H[depth]} ${active ? SIDEBAR_ROW_ACTIVE : idle}`;
}

/**
 * Ce que la barre DIT quand elle n'a rien à montrer — « Loading », « Nothing
 * here yet », le message d'une lecture en échec.
 *
 * Une phrase, pas un lien : elle prend la FORME d'une ligne de fil — mêmes
 * marges, même hauteur, même retrait que les lignes qu'elle remplace — sans en
 * prendre le survol, parce qu'il n'y a rien à cliquer. Écrite ici depuis le
 * 19/09/2026 (#230) : les dossiers et la section « Recent » la portent tous les
 * deux, et deux copies auraient fini par se décaler l'une de l'autre.
 */
export const SIDEBAR_NOTE = `${SIDEBAR_ROW} pr-2.5 pl-7 text-body-13 text-ink-4`;

/**
 * Ce qui est dans quoi : une entrée de menu, un dossier, le fil d'un dossier,
 * ou un fil de la section « Recent ».
 */
export type SidebarDepth = 'nav' | 'folder' | 'thread' | 'recent';

/**
 * Le retrait du CONTENU, et la graisse du texte. Le retrait aligne l'icône
 * d'un dossier sous le libellé de son parent, et le titre d'un fil sous le
 * libellé de son dossier — c'est la seule chose qui dise « ceci est dedans ».
 */
const DEPTH: Record<SidebarDepth, string> = {
  // 12 à gauche, 10 à droite, 10 entre l'icône et le libellé : les mesures de
  // la planche (487:5489). Le libellé est en Inter Medium 13.
  nav: 'gap-3 pr-2.5 pl-3 text-legacy-16 lg:gap-2.5 lg:text-medium-13 lg:leading-none!',
  folder: 'gap-2 pr-2.5 pl-3 text-body-13 lg:text-medium-13',
  // Le MÊME retrait que `folder` : le point d'un fil se pose dans la colonne
  // de l'icône de son dossier, et son titre commence là où commence le nom du
  // dossier (Quentin, 19/09/2026).
  // Regular 12 depuis le 20/09 : le contenu se lit un cran plus petit que le
  // menu qui le porte (planche 25:1062).
  thread: 'gap-2 pr-2.5 pl-7 text-body-13 lg:text-body-12',
  // Un fil de « Recent » : une place vide de 14 px là où les autres ont une
  // icône, puis le titre en Inter Regular 12, gris `ink-3`. Il ne porte AUCUN
  // point — la planche n'en dessine pas — et c'est la seule ligne du panneau
  // dans ce cas.
  recent: 'gap-2.5 pr-2.5 pl-3 text-body-13 lg:text-body-12',
};

type Props = {
  /**
   * Où mène la ligne. ABSENT quand la ligne ne mène nulle part et se contente
   * de plier ce qu'elle porte — c'est le cas des dossiers de Channels depuis le
   * 19/09/2026 : cliquer leur nom les déplie, et seul « See all » ouvre leur
   * liste. Sans `href`, la ligne est un `<button>` et `onToggle` la mène.
   */
  href?: string;
  /** Ce que la ligne plie, quand elle n'est pas un lien. */
  onToggle?: () => void;
  /** L'état que `onToggle` bascule — rendu en `aria-expanded`. */
  expanded?: boolean;
  /** L'infobulle, et le nom de la ligne quand elle est coupée. */
  title?: string;
  /** La ligne est-elle celle où l'on se trouve ? */
  active?: boolean;
  /** Pose `aria-current="page"` sur la ligne active. */
  markCurrent?: boolean;
  depth?: SidebarDepth;
  /** Ouvre dans un nouvel onglet : un lien qui QUITTE l'application. */
  external?: boolean;
  /** Le chevron. Frère du lien, dans le conteneur qui porte le survol. */
  caret?: ReactNode;
  /**
   * Une teinte de marque qui REMPLACE le fond d'état — le bouton Discord et
   * son bleu. Elle change la couleur, jamais la forme : marges, hauteur et
   * rayon restent ceux de toutes les autres lignes.
   */
  tint?: string;
  /** Posé sur le LIEN, qui est ce que les tests et les parcours cliquent. */
  testId?: string;
  children: ReactNode;
};

export default function SidebarRow({
  href,
  onToggle,
  expanded,
  title,
  active = false,
  markCurrent = false,
  depth = 'nav',
  external = false,
  caret,
  tint,
  testId,
  children,
}: Props) {
  // `text-left` sur TOUTES les lignes, lien comme bouton.
  //
  // Un `<button>` natif porte `text-align: center` dans la feuille de style du
  // navigateur, et le reset de Tailwind ne touche pas cette propriété-là. Le
  // jour où la ligne d'un dossier est devenue un bouton (19/09/2026), son
  // libellé est donc parti au MILIEU de la ligne — dans son `flex-1`, il
  // héritait du centrage — pendant que les lignes restées liens gardaient leur
  // alignement. Quentin l'a vu tout de suite : « qu'est-ce qui t'a pris de
  // centrer les Channels ? ». L'aligner ici, et pas sur le bouton seul, fait
  // que la question ne se repose pas à la prochaine ligne qui changera de
  // nature.
  const inner = `flex h-full min-w-0 flex-1 items-center text-left ${DEPTH[depth]}`;
  const commun = {
    title,
    'data-testid': testId,
    className: inner,
    ...(markCurrent && active ? { 'aria-current': 'page' as const } : {}),
  };

  return (
    <div
      // Le marqueur que le test lit pour comparer les lignes entre elles.
      data-sidebar-row=""
      className={
        tint === undefined
          ? sidebarRowClass(active, depth)
          : `${SIDEBAR_ROW_BASE} ${SIDEBAR_ROW_H[depth]} ${tint}`
      }
    >
      {href === undefined ? (
        // Une ligne qui ne mène nulle part est un BOUTON, pas un lien vidé de
        // son adresse : le clavier, le rôle annoncé et l'absence d'adresse à
        // copier en découlent tout seuls. C'est le seul `<button>` nu du rail,
        // et il est ici, dans `components/ui`, là où le DS touche l'élément
        // natif une fois pour toutes — la règle `no-restricted-syntax` y fait
        // exception pour cette raison exacte.
        <button type="button" onClick={onToggle} aria-expanded={expanded} {...commun}>
          {children}
        </button>
      ) : external ? (
        <a href={href} target="_blank" rel="noopener noreferrer" {...commun}>
          {children}
        </a>
      ) : (
        <Link href={href} {...commun}>
          {children}
        </Link>
      )}
      {caret}
    </div>
  );
}

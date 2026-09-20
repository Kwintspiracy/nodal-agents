'use client';

// RailCell — LA case du rail de la barre latérale, et il n'y en a qu'une
// (#230, 19/09/2026).
//
// Le rail porte des cases de même forme : trois destinations qui naviguent
// (Work, Agent, Run), Approvals et Settings qui naviguent aussi, Help qui ouvre
// une carte, et le compte, qui est un rond. Elles se ressemblent toutes parce
// qu'elles sont la MÊME case : une forme, un état, et un contenu qui varie.
//
// Elle vit dans `components/ui` pour la même raison que `SidebarRow` : c'est
// ici que le design system touche l'élément natif une fois pour toutes. La
// règle `no-restricted-syntax` y fait exception, et c'est pourquoi le `<button>`
// nu d'une case est ici et pas dans `SidebarRail`.

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import AttentionCount from './AttentionCount';

/**
 * La forme d'une case : 64 × 52, coins de 4 px. Identique pour toutes les
 * cases à libellé, active ou non.
 *
 * ⚠️ PLEINE LARGEUR depuis la v2 (#258). Elle faisait 56 px dans un rail de
 * 72, ce qui laissait 8 px de chaque côté ; la planche du 19/09 au soir la
 * dessine d'un bord à l'autre, moins les 4 px de retrait du rail. Une case
 * qui ne touche pas les bords se lit comme un bouton posé sur une colonne ;
 * pleine largeur, elle EST la colonne.
 *
 * ⚠️ RAYON 4, et plus `xl`. Le grand rayon venait des lignes du panneau ; la
 * planche v2 donne aux cases du rail un coin presque droit, et c'est ce qui
 * les distingue des lignes rondes d'à côté.
 *
 * Exportée parce qu'un test la compare d'une case à l'autre : c'est ce qui fait
 * de « toutes les cases se ressemblent » une chose vérifiable, et pas une
 * intention dans un commentaire.
 */
export const RAIL_CELL =
  'flex h-[52px] w-16 shrink-0 flex-col items-center justify-center gap-1 rounded-[4px] transition-colors';

/**
 * La case ACTIVE : fond papier, SANS bordure (#258).
 *
 * Elle en portait une en v1 pour tenir dans les deux thèmes. La planche v2 ne
 * la dessine pas, et le fond suffit maintenant qu'il est pleine largeur : un
 * trait autour d'une case qui touche les bords redessinerait la colonne.
 */
export const RAIL_CELL_ACTIVE = 'bg-paper text-ink';

/** La case au repos, et son survol. */
export const RAIL_CELL_IDLE = 'text-ink-3 hover:bg-hover hover:text-ink-2';

/** La classe complète d'une case — forme, puis état. Dans cet ordre. */
export function railCellClass(active = false): string {
  return `${RAIL_CELL} ${active ? RAIL_CELL_ACTIVE : RAIL_CELL_IDLE}`;
}

type Props = {
  /** Où mène la case. ABSENT quand elle ouvre une carte au lieu de naviguer. */
  href?: string;
  /**
   * La case QUITTE l'application — la documentation, qui est dehors (#258).
   *
   * Elle devient alors une ancre en cible neuve plutôt qu'un lien de routeur :
   * le routeur de Next ne sait pas naviguer hors du site, et une case « Help »
   * qui remplacerait l'onglet ferait perdre la page sur laquelle on travaille.
   */
  external?: boolean;
  /** Ce que la case fait quand elle ne mène nulle part. */
  onClick?: () => void;
  /** L'état que `onClick` bascule — rendu en `aria-expanded`. */
  expanded?: boolean;
  label: string;
  icon: PhosphorIcon;
  /** La case est-elle celle où l'on se trouve, ou celle dont la carte est ouverte ? */
  active?: boolean;
  /**
   * Ce qui ATTEND la personne sur cette case. Une pastille rouge posée sur le
   * coin, et RIEN à zéro : une pastille « 0 » demande d'être lue pour
   * apprendre qu'il n'y a rien à faire.
   *
   * La MÊME pastille que celle des dossiers du menu (`AttentionCount`), et le
   * même compte : celui d'`ApprovalsProvider`.
   */
  pill?: number;
  testId: string;
};

export default function RailCell({
  href,
  external = false,
  onClick,
  expanded,
  label,
  icon: Icon,
  active = false,
  pill,
  testId,
}: Props) {
  const contenu = (
    <>
      <Icon size={18} className="h-[18px] w-[18px]" />
      {/* 10 px demi-gras — le pas `micro-10` du DS, celui de la planche. */}
      <span className="text-micro-10 leading-none">{label}</span>
      {pill !== undefined && pill > 0 && (
        // Sur le COIN, et non à côté du libellé : une case du rail fait 56 px,
        // et un nombre posé dans la colonne pousserait l'icône hors de son axe.
        <AttentionCount count={pill} variant="solid" className="absolute top-1 right-1" />
      )}
    </>
  );
  const commun = {
    title: label,
    'data-testid': testId,
    // `relative` : la pastille se pose sur le coin de la case.
    className: `relative ${railCellClass(active)}`,
  };

  if (href === undefined) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-expanded={expanded}
        aria-haspopup="dialog"
        // Lu par `RailPopover` : un clic sur le bouton qui a ouvert la carte
        // n'est pas un clic « dehors », sinon la carte se fermerait et se
        // rouvrirait dans le même geste.
        data-rail-trigger=""
        {...commun}
      >
        {contenu}
      </button>
    );
  }

  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...commun}>
        {contenu}
      </a>
    );
  }

  return (
    <Link
      href={href}
      // `aria-current="page"` et non `"true"` : c'est bien la page en cours que
      // la case désigne, comme toute ligne de la barre (`SidebarRow`).
      {...(active ? { 'aria-current': 'page' as const } : {})}
      // LE NOMBRE SE DIT, il ne se laisse pas deviner (Reviewer C, passe 2 de
      // la PR #235). Sans ce nom, un lecteur d'écran annonce « Approvals 3 » :
      // le libellé et le chiffre collés, sans un mot pour dire ce que le
      // chiffre compte. « Approvals, 3 pending » le dit.
      //
      // « pending » et pas autre chose : c'est ce que la pastille SIGNIFIE —
      // ce qui attend une réponse de la personne — et c'est le seul sens
      // qu'elle ait dans la barre, sur les dossiers comme ici.
      {...(pill !== undefined && pill > 0 ? { 'aria-label': `${label}, ${pill} pending` } : {})}
      {...commun}
    >
      {contenu}
    </Link>
  );
}

/**
 * Le rond du compte, au tout bas du rail.
 *
 * Une case d'une autre forme — 28 px, ronde, sans libellé — parce que ce n'est
 * pas une destination : c'est qui l'on est. La planche le dessine ainsi.
 */
export function RailAvatarButton({
  onClick,
  expanded,
  children,
}: {
  onClick: () => void;
  expanded: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Account"
      aria-label="Account"
      aria-expanded={expanded}
      aria-haspopup="dialog"
      data-rail-trigger=""
      data-testid="rail-account"
      className={`flex h-7 w-7 items-center justify-center rounded-full border border-rule-2 bg-paper transition-colors ${
        expanded ? 'text-ink' : 'text-ink-3 hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

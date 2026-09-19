'use client';

// RailCell — LA case du rail de la barre latérale, et il n'y en a qu'une
// (#230, 19/09/2026).
//
// Le rail porte six cases de même forme : trois destinations qui naviguent
// (Talk, Build, Run), Settings qui navigue aussi, Help qui ouvre une carte, et
// le compte, qui est un rond. Elles se ressemblent toutes parce qu'elles sont
// la MÊME case : une forme, un état, et un contenu qui varie.
//
// Elle vit dans `components/ui` pour la même raison que `SidebarRow` : c'est
// ici que le design system touche l'élément natif une fois pour toutes. La
// règle `no-restricted-syntax` y fait exception, et c'est pourquoi le `<button>`
// nu d'une case est ici et pas dans `SidebarRail`.

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';

/**
 * La forme d'une case : 56 × 52, coins `xl`. Identique pour les cinq cases à
 * libellé, active ou non.
 *
 * Exportée parce qu'un test la compare d'une case à l'autre : c'est ce qui fait
 * de « toutes les cases se ressemblent » une chose vérifiable, et pas une
 * intention dans un commentaire.
 */
export const RAIL_CELL =
  'flex h-[52px] w-14 shrink-0 flex-col items-center justify-center gap-1 rounded-xl transition-colors';

/** La case ACTIVE : fond papier cerné, donc « en relief » quel que soit le thème. */
export const RAIL_CELL_ACTIVE = 'bg-paper border border-rule-2 text-ink';

/** La case au repos, et son survol. */
export const RAIL_CELL_IDLE = 'text-ink-3 hover:bg-hover hover:text-ink-2';

/** La classe complète d'une case — forme, puis état. Dans cet ordre. */
export function railCellClass(active = false): string {
  return `${RAIL_CELL} ${active ? RAIL_CELL_ACTIVE : RAIL_CELL_IDLE}`;
}

type Props = {
  /** Où mène la case. ABSENT quand elle ouvre une carte au lieu de naviguer. */
  href?: string;
  /** Ce que la case fait quand elle ne mène nulle part. */
  onClick?: () => void;
  /** L'état que `onClick` bascule — rendu en `aria-expanded`. */
  expanded?: boolean;
  label: string;
  icon: PhosphorIcon;
  /** La case est-elle celle où l'on se trouve, ou celle dont la carte est ouverte ? */
  active?: boolean;
  testId: string;
};

export default function RailCell({
  href,
  onClick,
  expanded,
  label,
  icon: Icon,
  active = false,
  testId,
}: Props) {
  const contenu = (
    <>
      <Icon size={18} className="h-[18px] w-[18px]" />
      {/* 10 px demi-gras — le pas `micro-10` du DS, celui de la planche. */}
      <span className="text-micro-10 leading-none">{label}</span>
    </>
  );
  const commun = {
    title: label,
    'data-testid': testId,
    className: railCellClass(active),
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

  return (
    <Link
      href={href}
      // `aria-current="page"` et non `"true"` : c'est bien la page en cours que
      // la case désigne, comme toute ligne de la barre (`SidebarRow`).
      {...(active ? { 'aria-current': 'page' as const } : {})}
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

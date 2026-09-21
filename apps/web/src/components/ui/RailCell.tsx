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
import LiveDot from './LiveDot';

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
  /**
   * CE QUI TOURNE derrière la case, quand quelque chose tourne (#300, #303).
   *
   * Le MÊME point que partout ailleurs dans le produit — `LiveDot` lime, avec
   * son halo qui bat — parce que « ça avance » se dit d'une seule façon : sur
   * une ligne d'agent de la barre, sur une ligne de conversation, et ici.
   *
   * `count` à zéro ne dessine RIEN, comme la pastille : un point éteint se
   * lirait comme un point, et il faudrait s'approcher pour apprendre qu'il n'y
   * a rien. `noun` est ce que le compte compte, et il part dans le nom
   * accessible : la case Logs compte des runs, la case Work des conversations,
   * et les deux ne veulent pas dire la même chose.
   */
  running?: RailCellRunning;
  testId: string;
};

/** Ce qui tourne derrière une case : combien, et de quoi il s'agit. */
export type RailCellRunning = {
  count: number;
  noun: 'run' | 'conversation';
};

/**
 * LE NOM QUE LA CASE ANNONCE, quand il ne suffit pas de lire son libellé.
 *
 * Exporté parce qu'un test le compare au texte attendu sans monter le rail
 * entier, et parce que les trois cas — rien, un compte en attente, un compte
 * qui tourne — tiennent dans une seule fonction qu'on peut lire d'un coup.
 *
 * `undefined` quand le libellé se suffit : une case sans chiffre n'a pas
 * besoin d'un `aria-label` qui répète son texte.
 */
export function railCellName(
  label: string,
  pill: number | undefined,
  running: RailCellRunning | undefined,
): string | undefined {
  const parts: string[] = [];
  // « pending » et pas autre chose : c'est ce que la pastille SIGNIFIE — ce qui
  // attend une réponse de la personne — et c'est le seul sens qu'elle ait dans
  // la barre, sur les dossiers comme ici.
  if (pill !== undefined && pill > 0) parts.push(`${pill} pending`);
  if (running !== undefined && running.count > 0) {
    const noun = running.count === 1 ? running.noun : `${running.noun}s`;
    parts.push(`${running.count} ${noun} in progress`);
  }
  if (parts.length === 0) return undefined;
  return `${label}, ${parts.join(', ')}`;
}

export default function RailCell({
  href,
  external = false,
  onClick,
  expanded,
  label,
  icon: Icon,
  active = false,
  pill,
  running,
  testId,
}: Props) {
  const nom = railCellName(label, pill, running);
  // RIEN À ZÉRO, pour l'une comme pour l'autre : une pastille « 0 » ou un point
  // éteint demandent d'être lus pour apprendre qu'il n'y a rien à faire.
  const nombre = pill !== undefined && pill > 0 ? pill : null;
  const point = running !== undefined && running.count > 0;
  const contenu = (
    <>
      <Icon size={18} className="h-[18px] w-[18px]" />
      {/* 10 px demi-gras — le pas `micro-10` du DS, celui de la planche. */}
      <span className="text-micro-10 leading-none">{label}</span>
      {(nombre !== null || point) && (
        // LES DEUX MARQUES PARTAGENT LE BORD DROIT (décision du propriétaire,
        // 22/09/2026 : « sur l'onglet Work, la puce d'activité doit être à
        // droite »).
        //
        // Elles n'étaient pas au même endroit : la pastille au coin droit, le
        // point au coin gauche, chacun le sien pour qu'ils ne se croisent
        // jamais. Le point s'est retrouvé du côté où rien d'autre ne vit, seul
        // à gauche d'une colonne dont tout le reste est centré, et c'est ce qui
        // se voyait.
        //
        // UNE COLONNE tient la même promesse sans deux coins : empilées par le
        // flux, les marques ne peuvent pas se recouvrir, quelle que soit la
        // case et même si l'une portait un jour les deux.
        //
        // ⚠️ EMPILÉES, et non côte à côte (Reviewer C). Une rangée s'élargit
        // vers la gauche depuis le bord droit : la pastille fait 18 px à un
        // chiffre et jusqu'à 42 px à « 99+ », si bien que la seconde marque
        // arrivait sur le coin de l'icône, qui tient le milieu de la case. En
        // colonne, la largeur reste celle de la marque la plus large, et
        // l'icône garde son axe.
        //
        // L'ordre est celui du nom de la case (`railCellName`) : ce qui attend,
        // puis ce qui avance.
        //
        // Sur le COIN, et non à côté du libellé : une case du rail fait 64 px,
        // et une marque posée dans la colonne pousserait l'icône hors de son axe.
        <span className="absolute top-1 right-1 flex flex-col items-end gap-1">
          {nombre !== null && <AttentionCount count={nombre} variant="solid" />}
          {point && (
            // `aria-hidden` : ce que le point dit, le nom de la case le dit
            // déjà en toutes lettres. Annoncé deux fois, il deviendrait un
            // bruit.
            <span
              aria-hidden="true"
              data-testid={`${testId}-running`}
              className="flex h-2 w-2 items-center justify-center"
            >
              <LiveDot variant="lime" size="sm" />
            </span>
          )}
        </span>
      )}
    </>
  );
  const commun = {
    title: label,
    'data-testid': testId,
    // LE NOMBRE SE DIT, il ne se laisse pas deviner (Reviewer C, passe 2 de la
    // PR #235). Sans ce nom, un lecteur d'écran annonce « Approvals 3 » : le
    // libellé et le chiffre collés, sans un mot pour dire ce que le chiffre
    // compte. « Approvals, 3 pending » le dit, et « Logs, 2 runs in progress »
    // aussi — un point coloré, lui, ne s'annonce pas du tout.
    ...(nom !== undefined ? { 'aria-label': nom } : {}),
    // `relative` : la pastille et le point se posent sur le coin de la case.
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

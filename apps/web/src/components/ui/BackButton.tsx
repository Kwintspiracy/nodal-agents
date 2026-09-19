'use client';

import { useRouter, usePathname } from 'next/navigation';
import type { MouseEvent } from 'react';
import { CaretLeft } from '@phosphor-icons/react';
import { backTarget, readTrail } from '@/lib/navigation-trail.ts';

/** Le dessin du composant Figma (93:10) — le repli quand la page n'en demande pas d'autre. */
const LOOK_PAR_DEFAUT = 'py-2 text-medium-14 leading-none! hover:text-ink';

type Props = {
  /**
   * Le parent DÉTERMINISTE de la page — là où « Back » mène quand cet onglet
   * n'a pas de page précédente (lien collé dans un nouvel onglet, tout premier
   * chargement). Obligatoire : une page de détail sait toujours à quelle liste
   * elle appartient, et un retour sans destination de repli est un cul-de-sac.
   */
  parent: string;
  /** Le libellé après le chevron. Chaque page garde le sien. */
  label?: string;
  /** Le dessin du retour sur cette page : type, couleur, gouttières. */
  className?: string;
};

/**
 * BackButton — LE mécanisme de retour de l'app (#232, 19/09/2026).
 *
 * Constat du propriétaire, deux fois le 19/09 : une automation puis un de ses
 * runs, « Back » ramenait à Scheduled ; un workspace puis une de ses
 * conversations, « Back » ramenait à Nodal chats. Le composant prenait alors
 * soit un `href` absolu, soit rien (`router.back()`), et chaque page de détail
 * choisissait — le choix étant faux pour l'autre chemin d'arrivée.
 *
 * Désormais il décide seul, en lisant le fil tenu par `<NavigationTrail />` :
 * une page précédente de l'app ⇒ on y revient ; sinon ⇒ le `parent`. Le même
 * écran atteint depuis deux endroits repart donc à deux endroits, et c'est
 * tout l'objet de l'issue.
 *
 * C'est une ANCRE, pas un bouton : son `href` est le parent, donc le clic du
 * milieu et « ouvrir dans un nouvel onglet » mènent quelque part de sensé, et
 * seul le clic ordinaire est intercepté pour appliquer la règle.
 */
export default function BackButton({ parent, label = 'Back', className = LOOK_PAR_DEFAUT }: Props) {
  const router = useRouter();
  const pathname = usePathname();

  function onClick(event: MouseEvent<HTMLAnchorElement>): void {
    // Clic du milieu, Ctrl/Cmd, Maj, Alt : c'est le navigateur qui décide, et
    // il ouvrira le `parent` — ce que fait n'importe quel lien.
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    const target = backTarget(readTrail(), pathname ?? '');
    if (target === null) {
      router.push(parent);
      return;
    }
    if (target.mode === 'back') {
      router.back();
      return;
    }
    router.push(target.path);
  }

  return (
    <a
      href={parent}
      onClick={onClick}
      data-testid="back-button"
      className={`inline-flex shrink-0 items-center gap-1.5 border-0 bg-transparent text-ink-3 transition-colors ${className}`}
    >
      <CaretLeft size={14} weight="bold" />
      {label}
    </a>
  );
}

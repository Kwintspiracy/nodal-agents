import Link from 'next/link';
import { Plus } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

/**
 * SidebarSection — le titre en capitales qui ouvre un bloc du panneau.
 *
 * Mesures de la planche de Quentin (19/09/2026, Figma 487:5489, reprises
 * telles quelles par la v2) : mono 11, `ink-4`, interlettrage 14 %, et 14 px
 * au-dessus, 6 px en dessous, 12 px sur les côtés — le MÊME retrait latéral
 * que l'icône d'une ligne, si bien que le titre du bloc et les icônes en
 * dessous tombent sur une seule verticale.
 *
 * Le mobile garde ses marges d'origine : un titre serré entre deux lignes de
 * 48 px se lit mal.
 */
export default function SidebarSection({
  add,
  children,
}: {
  /**
   * Le « + » du titre, et où il mène (#258).
   *
   * La planche des cinq panneaux ne le dessine que sur CRON et sur WEBHOOKS ;
   * PROJECTS l'a reçu le 20/09 (#301), parce que sa section vide ne porte plus
   * « See all » et qu'il faut bien un chemin vers `/spaces`. Trois sections,
   * donc, et trois seulement : celles où l'on CRÉE quelque chose depuis le
   * menu. Un « + » sur RECENTS ou sur APPROVALS promettrait un geste qui
   * n'existe pas là.
   *
   * Deux formes. Un LIEN (`href`) quand il mène à la page où l'on crée : il a
   * une adresse, et on peut l'ouvrir dans un onglet comme n'importe quelle
   * autre entrée du menu. Un BOUTON (`onOpen`) quand il ouvre le formulaire en
   * place, sans quitter la page où l'on est — il n'a alors pas d'adresse.
   */
  add?: { label: string; href: string } | { label: string; onOpen: () => void };
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-3 pt-4 pb-1.5 lg:pt-3.5 lg:pb-1.5">
      <div className="min-w-0 flex-1 truncate text-mono-11 tracking-[0.14em] text-ink-4 uppercase">
        {children}
      </div>
      {add !== undefined && <AddControl add={add} />}
    </div>
  );
}

const ADD_CLASS =
  'flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-4 transition-colors hover:text-ink-2';

/** Le « + », lien ou bouton : le MÊME dessin, le même nom, la même ancre de test. */
function AddControl({
  add,
}: {
  add: { label: string; href: string } | { label: string; onOpen: () => void };
}) {
  // Le nom DIT le geste, pas le signe : un lecteur d'écran annonce
  // « New automation », pas « plus ».
  const common = {
    'aria-label': add.label,
    title: add.label,
    'data-testid': 'section-add',
    className: ADD_CLASS,
  };
  const plus = <Plus size={16} className="h-4 w-4" />;
  if ('href' in add) {
    return (
      <Link href={add.href} {...common}>
        {plus}
      </Link>
    );
  }
  return (
    <button type="button" onClick={add.onOpen} {...common}>
      {plus}
    </button>
  );
}

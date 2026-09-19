'use client';

// SidebarCaret — le chevron qui déplie une ligne de la barre latérale
// (Quentin, 18/09/2026).
//
// Pourquoi il n'est pas un `DisclosureButton`. Celui-ci est un `<button>` qui
// PORTE le contenu de la ligne ; or les lignes qui se déplient ici — le groupe
// Channels, chacun de ses dossiers — sont déjà des LIENS, et un bouton ne peut
// pas contenir un lien. Le chevron est donc le FRÈRE du lien, à l'intérieur de
// la ligne (`SidebarRow`) : cliquer le nom ouvre le dossier, cliquer le chevron
// le déplie sur place, et le survol, qui appartient à la LIGNE, éclaire les
// deux d'un seul tenant. Il a son propre focus clavier — c'est un vrai
// `<button>` — et il ne navigue jamais.
//
// Même primitif que partout ailleurs (`IconButton` en mode `ghost`, les carets
// Phosphor du DS) : ni `<button>` nu, ni SVG dessiné à la main.

import { CaretDown, CaretRight } from '@phosphor-icons/react';
import IconButton from './IconButton';

type Props = {
  open: boolean;
  onToggle: () => void;
  /** Ce que le chevron déplie, nommé pour un lecteur d'écran (« Channels »). */
  label: string;
  /** Passé en `data-testid` — la cible des tests et des parcours. */
  testId?: string;
  className?: string;
};

export default function SidebarCaret({ open, onToggle, label, testId, className = '' }: Props) {
  // Le nom dit le GESTE, pas l'état : « Expand Telegram » quand il est fermé.
  const aria = open ? `Collapse ${label}` : `Expand ${label}`;
  return (
    <IconButton
      ghost
      onClick={onToggle}
      aria-expanded={open}
      aria-label={aria}
      title={aria}
      data-testid={testId}
      // `mr-2` et pas `mr-3` : la ligne porte déjà sa marge, et le chevron ne
      // règle plus que son retrait DEDANS. Pas de fond propre au survol — il
      // appartient à la ligne, et deux fonds superposés se verraient.
      // `ink-4` et un trait FIN (planches du 19/09/2026) : la planche écrit un
      // simple « › » gris, et un chevron gras attirait l'œil plus que le nom du
      // dossier qu'il ouvre. La zone cliquable, elle, ne bouge pas.
      className={`mr-1 h-9 w-9 rounded-lg text-ink-4 hover:text-ink-2 lg:h-6 lg:w-6 ${className}`}
    >
      {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
    </IconButton>
  );
}

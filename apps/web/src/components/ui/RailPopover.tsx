'use client';

// RailPopover — LA petite carte qu'une entrée du BAS du rail ouvre (#230), et
// il n'y en a qu'une : Help et le compte ouvrent le MÊME composant.
//
// Pourquoi elle existe. Le rail fait 72 px de large : le bloc de compte
// (courriel + Sign out) et les trois liens « À propos » de la 0.8.11 n'y
// tiennent pas en pleine largeur. Les retirer aurait supprimé des fonctions du
// produit, ce que l'issue interdit ; les poser dans le panneau les aurait fait
// changer de place selon la destination active. Ils s'ouvrent donc À CÔTÉ de
// l'entrée qui les porte, et se ferment comme toute carte du produit : au clic
// dehors, à Échap.
//
// Le clic dehors suit la cloche des approbations (`NotificationsBell`), et
// Échap passe par la PILE DES CALQUES (`@/lib/layers.ts`, #233) : la touche va
// au calque ouvert le plus INTÉRIEUR, qui est cette carte quand elle est
// ouverte au-dessus du menu mobile. C'est la règle de l'app, pas un dialecte
// de plus — et c'est elle qui sait dire ce que la phase de capture ne savait
// pas : « le plus intérieur d'abord ».
//
// AUCUN dialogue natif du navigateur (invariant #10) : c'est un
// `<div role="dialog">` du design system, d'où sa place ici, dans
// `components/ui`, à côté des autres primitifs.

import { useEffect, useRef, type ReactNode } from 'react';
import { useLayer } from '@/lib/layers.ts';

type Props = {
  /** Ce que la carte montre, nommé pour un lecteur d'écran. */
  label: string;
  onClose: () => void;
  children: ReactNode;
};

export default function RailPopover({ label, onClose, children }: Props) {
  const carte = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function dehors(e: PointerEvent) {
      // Le bouton qui a ouvert la carte est HORS de celle-ci : son propre
      // `onClick` rebascule l'état, et fermer ici en plus rouvrirait aussitôt.
      // Il porte donc `data-rail-trigger`, et ce clic-là n'est pas « dehors ».
      const cible = e.target as Element | null;
      if (carte.current?.contains(cible ?? null) === true) return;
      if (cible?.closest('[data-rail-trigger]') !== null && cible !== null) return;
      onClose();
    }
    document.addEventListener('pointerdown', dehors);
    return () => document.removeEventListener('pointerdown', dehors);
  }, [onClose]);

  // Échap, par la pile : rendue, cette carte EST ouverte — elle n'existe pas
  // autrement — donc elle s'inscrit sans condition.
  useLayer(true, onClose);

  return (
    <div
      ref={carte}
      role="dialog"
      aria-label={label}
      data-testid="rail-popover"
      // Elle sort du rail par la DROITE et se cale sur le bas de son entrée :
      // le rail est collé au bord gauche de l'écran, et une carte à sa gauche
      // n'aurait nulle part où aller.
      className="absolute bottom-0 left-full z-50 ml-2 w-[248px] rounded-xl border border-rule-2 bg-paper p-1.5 shadow-lg"
    >
      {children}
    </div>
  );
}

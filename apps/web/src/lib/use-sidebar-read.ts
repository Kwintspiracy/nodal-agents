'use client';

// use-sidebar-read.ts — LA lecture d'une section de la barre latérale (#258).
//
// Les cinq panneaux de la planche du propriétaire portent sept listes qui
// n'existent qu'en base : les espaces de travail, les canaux, les agents, les
// tâches planifiées, les webhooks, les approbations en attente et celles qui
// ont reçu une réponse. Elles se lisent toutes de la même façon, et ce hook est
// cette façon — écrite UNE fois.
//
// Ce qu'il tient, et que chaque copie devait retenir :
//
//   - l'ÂGE de la lecture en vol. Une navigation et un tour d'horloge peuvent
//     avoir deux lectures en l'air, et rien n'ordonne leurs réponses : sans
//     âge, la plus ancienne qui revient en dernier réécrit la liste avec un
//     état périmé. Le démontage périme tout ce qui est en vol par le même
//     chemin (garde de la passe 2 de la revue de la PR #223) ;
//   - la CADENCE de la barre, une seule pour toute la colonne
//     (`SIDEBAR_POLL_MS`) : une liste qui se rafraîchirait plus vite qu'une
//     autre ferait dire deux heures différentes à la même barre ;
//   - la relecture À CHAQUE NAVIGATION. Ouvrir une page écrit parfois côté
//     serveur ce que la barre affiche — le marqueur de lecture d'un fil, par
//     exemple — et la barre, cliente, survit à la navigation : rien ne la
//     préviendrait ;
//   - le SILENCE quand la section est repliée. `actif` à faux ne lit rien : un
//     dossier replié ne fait payer aucune requête à la page.
//
// ⚠️ UN ÉCHEC SE DIT. `erreur` porte le message de l'action, et l'appelant
// l'affiche à la place de la liste : une liste vide se lirait « il n'y a rien
// ici », ce qui est un fait que la lecture n'a justement pas établi
// (invariant #4).

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { usePolling, SIDEBAR_POLL_MS } from './use-polling.ts';

/** Ce qu'une action de barre latérale répond. La forme commune à toutes. */
type Lecture<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

export type SidebarRead<T> = {
  /** `null` tant que la lecture n'a pas répondu. Un tableau vide est un fait. */
  rows: readonly T[] | null;
  /** Ce que la lecture a répondu quand elle a échoué. Jamais un silence. */
  erreur: string | null;
  /**
   * Relit TOUT DE SUITE, sans attendre le tour d'horloge : ce qu'une ligne
   * appelle après avoir renommé ou supprimé ce qu'elle porte (20/09), pour que
   * le menu dise le nouvel état au moment où la personne le regarde.
   */
  relire: () => Promise<void>;
};

export function useSidebarRead<T>(
  /**
   * La lecture. Elle doit être STABLE — un `useCallback` chez l'appelant, ou
   * une référence de module : redéfinie à chaque rendu, elle relancerait le
   * sondage sans fin.
   */
  lire: () => Promise<Lecture<readonly T[]>>,
  /** La section est-elle sous les yeux ? À faux, aucune requête ne part. */
  actif = true,
): SidebarRead<T> {
  const pathname = usePathname();
  const [rows, setRows] = useState<readonly T[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const age = useRef(0);
  useEffect(() => {
    return () => {
      age.current += 1;
    };
  }, []);

  const relire = useCallback(async (): Promise<void> => {
    if (!actif) return;
    const mien = (age.current += 1);
    const r = await lire();
    // Périmée : l'écran est démonté, ou une lecture plus récente est partie
    // depuis. Dans les deux cas il n'y a rien à dessiner avec ça.
    if (mien !== age.current) return;
    if (r.ok) {
      setRows(r.data);
      // Une lecture qui repasse efface le message de la précédente : sinon la
      // section garderait sous les yeux une panne déjà réparée.
      setErreur(null);
      return;
    }
    setErreur(r.message);
    // `pathname` est le DÉCLENCHEUR de la relecture, pas une donnée qu'elle
    // lit : la règle des dépendances le voit comme inutile, et il est au
    // contraire tout le sujet. Le retirer figerait la barre entre deux tours
    // d'horloge (#223).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actif, lire, pathname]);

  usePolling(relire, SIDEBAR_POLL_MS, true);

  return { rows, erreur, relire };
}

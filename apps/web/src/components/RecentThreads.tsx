'use client';

// RecentThreads — la section « Recent » du panneau Talk (#230, 19/09/2026).
//
// Les cinq derniers fils TOUS CANAUX CONFONDUS, puis « See all » vers la liste
// entière. C'est la seule chose du panneau qui regarde par-dessus les dossiers :
// un dossier répond à « où ça se passe », celle-ci à « qu'est-ce que je viens
// de faire ».
//
// Les titres sont ceux que la lecture écrit — masqués, coupés et nommés à la
// source. Rien n'est recalculé ici.
//
// ⚠️ UNE LIGNE DE « RECENT » NE PORTE AUCUN POINT, et c'est la seule du
// panneau dans ce cas (planches de Quentin du 19/09/2026, Figma 487:5489).
// Elle a une place vide là où un dossier a son icône, puis son titre en gris.
// Conséquence à dire tout haut : l'état NON LU de #209 ne se dessine plus
// ici. Il reste entier dans le sous-menu d'un dossier, qui est l'endroit où
// l'on choisit un fil ; « Recent » est un rappel de ce qu'on vient de faire,
// et le propriétaire l'a dessinée sans signal.
//
// ⚠️ ELLE NE FAIT QU'UNE SEULE LECTURE. Sans point à peindre, il ne reste que
// les titres et leurs adresses (Reviewer C, passe 1 de la PR #235, qui
// relevait trois actions serveur là où une suffit).
//
// ⚠️ LA LECTURE PART AU MONTAGE, et pas au premier clic comme celle des
// sous-menus : la section est VISIBLE dès que le panneau Talk s'affiche, donc
// il n'y a rien à attendre. Elle ne part que sur les routes de Talk, puisque
// c'est le seul panneau qui la porte.
//
// ⚠️ ET ELLE SE RELIT, sur la CADENCE DE LA BARRE (`SIDEBAR_POLL_MS`). Ce
// n'est pas un ajout de confort : le sous-menu d'un dossier se relit depuis
// #223, exactement pour que son point de non-lu ne mente pas, et une section
// figée juste en dessous aurait fait dire deux heures différentes à la même
// barre. Deux déclencheurs, le même hook que partout :
//
//   - la NAVIGATION. `pathname` est une dépendance VOULUE de `relireSurRoute`,
//     et elle ne sert pas au calcul : elle change l'identité de la fonction à
//     chaque changement d'adresse, ce qui relance l'effet et, avec
//     `immediate`, refait la lecture sur-le-champ. C'est ce qui éteint le
//     point du fil qu'on vient d'ouvrir — son marqueur de lecture est écrit
//     par le rendu serveur de sa page, et ce changement de chemin arrive après ;
//   - l'HORLOGE, qui allume le point d'un fil qui reçoit pendant qu'on regarde
//     ailleurs, saute les tours quand l'onglet est caché, et relit dès qu'il
//     revient.
//
// ⚠️ ELLE NE S'ÉTEINT PAS, et c'est la seule chose qu'elle ne reprend PAS du
// sous-menu des dossiers. Celui-ci arrête son sondage dès que tout est replié,
// parce qu'il n'y a alors plus rien à l'écran à tenir à jour. « Recent » n'a
// pas d'état replié : elle est visible tant que le panneau Talk l'est, et
// démontée dès qu'on quitte Talk. Le sondage suit donc exactement sa présence
// à l'écran, ce qui est le même critère, atteint autrement.

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ArrowRight } from '@phosphor-icons/react';
import SidebarSection from './ui/SidebarSection';
import SidebarRow, { SIDEBAR_NOTE } from './ui/SidebarRow';
import {
  listRecentThreadReadsAction,
  type FolderConversationRead,
} from '@/lib/conversation-actions.ts';
import { usePolling, SIDEBAR_POLL_MS } from '@/lib/use-polling';
import { RECENT_THREADS_MAX } from '@/lib/chat-folders.ts';

export default function RecentThreads() {
  const pathname = usePathname();
  /** `null` = la lecture n'a pas encore répondu. Un tableau vide est un fait. */
  const [fils, setFils] = useState<readonly FolderConversationRead[] | null>(null);
  /** Ce que la lecture a répondu quand elle a échoué. Jamais un silence. */
  const [erreur, setErreur] = useState<string | null>(null);

  /**
   * L'ÂGE de la lecture qu'on attend. Une réponse ne s'affiche que si elle est
   * encore celle-là — la MÊME garde que le sous-menu des dossiers (Reviewer C,
   * passe 2 de la PR #223), et pour la même raison.
   *
   * DEUX lectures peuvent être en vol en même temps : celle qu'une navigation
   * vient de lancer et celle du tour d'horloge. Rien ne garantit l'ordre des
   * réponses, et sans cet âge la plus ancienne qui revient en dernier réécrit
   * la section avec un état périmé — précisément le point de non-lu qu'on
   * venait d'éteindre en ouvrant le fil.
   *
   * Le démontage périme tout ce qui est en vol, par le même chemin : une
   * réponse qui arrive après ne dessine rien.
   */
  const age = useRef(0);
  useEffect(() => {
    return () => {
      age.current += 1;
    };
  }, []);

  const relire = useCallback(async (): Promise<void> => {
    const mien = (age.current += 1);
    const r = await listRecentThreadReadsAction(RECENT_THREADS_MAX);
    // Périmée : l'écran est démonté, ou une lecture plus récente est partie
    // depuis. Dans les deux cas il n'y a rien à dessiner avec ça.
    if (mien !== age.current) return;
    if (r.ok) {
      setFils(r.data);
      // Une lecture qui repasse efface le message de la précédente : sinon la
      // section garderait sous les yeux une panne déjà réparée.
      setErreur(null);
      return;
    }
    // Un échec se DIT à la place des lignes : une section vide et une section
    // illisible se ressemblent trait pour trait (invariant #4).
    setErreur(r.message);
  }, []);

  const relireSurRoute = useCallback(async (): Promise<void> => {
    await relire();
    // `pathname` est le DÉCLENCHEUR de la relecture, pas une donnée qu'elle
    // lit : la règle le voit comme inutile, et il est au contraire tout le
    // sujet. Le retirer laisserait allumé le point du fil qu'on vient
    // d'ouvrir, jusqu'au prochain tour d'horloge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relire, pathname]);
  usePolling(relireSurRoute, SIDEBAR_POLL_MS, true);

  return (
    <div data-testid="recent-threads">
      <SidebarSection>Recent</SidebarSection>
      {erreur !== null ? (
        <p className={SIDEBAR_NOTE}>{erreur}</p>
      ) : fils === null ? (
        <p className={SIDEBAR_NOTE}>Loading</p>
      ) : fils.length === 0 ? (
        <p className={SIDEBAR_NOTE}>Nothing here yet</p>
      ) : (
        fils.map((t) => (
          <SidebarRow
            key={t.id}
            href={`/chat/${t.id}`}
            title={t.title}
            depth="recent"
            testId="recent-thread"
          >
            {/* Une place vide de la largeur d'une icône : les titres de
                « Recent » s'alignent alors sur les libellés des dossiers
                au-dessus, sans rien mettre devant eux. */}
            <span className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 truncate leading-5">{t.title}</span>
          </SidebarRow>
        ))
      )}
      {/* « See all » mène à la liste entière, et c'est la SEULE ligne de la
          section qui y mène — comme dans le sous-menu d'un dossier. Cinq fils
          ne sont pas tous les fils, et rien d'autre ne le dirait. */}
      <SidebarRow href="/chat" title="See all" depth="recent" testId="recent-see-all">
        <span className="h-3.5 w-3.5 shrink-0" />
        {/* Le MÊME poids que les fils au-dessus : la planche ne le met pas en
            gras, et un « See all » plus lourd que les titres se lirait comme
            l'entrée principale de la section. */}
        <span className="flex-1 truncate leading-5">See all</span>
        <ArrowRight size={12} data-testid="see-all-arrow" className="h-3 w-3 shrink-0 text-ink-3" />
      </SidebarRow>
    </div>
  );
}

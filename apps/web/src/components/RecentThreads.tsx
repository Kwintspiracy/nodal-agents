'use client';

// RecentThreads — la section « Recent » du panneau Talk (#230, 19/09/2026).
//
// Les cinq derniers fils TOUS CANAUX CONFONDUS, puis « See all » vers la liste
// entière. C'est la seule chose du panneau qui regarde par-dessus les dossiers :
// un dossier répond à « où ça se passe », celle-ci à « qu'est-ce que je viens
// de faire ».
//
// Ce sont les MÊMES lignes qu'ailleurs — même forme (`SidebarRow` en
// profondeur `thread`), même point (`ThreadDot`, #209), même titre (écrit par
// la lecture, masqué et coupé à la source). Rien n'est recalculé ici.
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

import { useCallback, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ArrowRight } from '@phosphor-icons/react';
import SidebarSection from './ui/SidebarSection';
import SidebarRow, { SIDEBAR_NOTE } from './ui/SidebarRow';
import ThreadDot from './ui/ThreadDot';
import { listRecentThreadsAction } from '@/lib/recent-threads-actions.ts';
import { usePolling, SIDEBAR_POLL_MS } from '@/lib/use-polling';
import type { FolderThread } from '@/lib/chat-folders.ts';

export default function RecentThreads() {
  const pathname = usePathname();
  /** `null` = la lecture n'a pas encore répondu. Un tableau vide est un fait. */
  const [fils, setFils] = useState<readonly FolderThread[] | null>(null);
  /** Ce que la lecture a répondu quand elle a échoué. Jamais un silence. */
  const [erreur, setErreur] = useState<string | null>(null);

  const relire = useCallback(async (): Promise<void> => {
    const r = await listRecentThreadsAction();
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
            key={t.key}
            href={t.href}
            title={t.title}
            depth="thread"
            testId="recent-thread"
          >
            <ThreadDot thread={t} />
            <span className="flex-1 truncate leading-5">{t.title}</span>
          </SidebarRow>
        ))
      )}
      {/* « See all » mène à la liste entière, et c'est la SEULE ligne de la
          section qui y mène — comme dans le sous-menu d'un dossier. Cinq fils
          ne sont pas tous les fils, et rien d'autre ne le dirait. */}
      <SidebarRow href="/chat" title="See all" depth="thread" testId="recent-see-all">
        {/* Une place vide de la largeur d'un point : le libellé s'aligne alors
            sur les titres des fils au-dessus. */}
        <span className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 truncate leading-5 font-medium!">See all</span>
        <ArrowRight
          size={14}
          weight="bold"
          data-testid="see-all-arrow"
          className="h-3.5 w-3.5 shrink-0 text-ink-4"
        />
      </SidebarRow>
    </div>
  );
}

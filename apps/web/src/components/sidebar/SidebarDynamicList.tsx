'use client';

// SidebarDynamicList — UNE section du panneau qui se lit en base (#258).
//
// La planche du propriétaire porte sept listes de ce genre, et quatre d'entre
// elles — CRON, WEBHOOKS, APPROVALS, RECENTS — sont exactement la même chose :
// un plafond de lignes, un nom par ligne, une adresse par ligne, et une phrase
// encadrée quand il n'y a rien. Les écrire quatre fois aurait donné quatre
// façons de dire « ça charge », « ça a raté » et « il n'y a rien ».
//
// ⚠️ LES TROIS ABSENCES NE SE DISENT PAS PAREIL, et c'est tout le sujet :
//
//   - LA LECTURE N'A PAS RÉPONDU → « Loading ». On ne sait rien encore.
//   - LA LECTURE A ÉCHOUÉ → son message, tel quel. Un menu qui se tairait
//     ferait croire à une liste vide, c'est-à-dire afficherait un fait que
//     rien n'a établi (invariant #4).
//   - LA LECTURE A RÉPONDU « RIEN » → le cadre en pointillés de la planche.
//     Là, et là seulement, « il n'y a rien » est un fait.
//
// ⚠️ LA LECTURE EST BORNÉE, et d'un de plus que ce qu'on dessine : la ligne en
// trop n'est jamais affichée, elle est la RÉPONSE à « y en a-t-il d'autres ? ».
// C'est la mécanique des sous-menus de canaux (`FOLDER_THREADS_PROBE`), reprise
// telle quelle plutôt que réinventée.

import { useCallback, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { ArrowRight } from '@phosphor-icons/react';
import SidebarRow, { SIDEBAR_NOTE } from '../ui/SidebarRow';
import SidebarEmpty from '../ui/SidebarEmpty';
import ThreadDot from '../ui/ThreadDot';
import LiveDot from '../ui/LiveDot';
import { useSidebarRead } from '@/lib/use-sidebar-read.ts';
import { FOLDER_THREADS_PROBE, unfoldedRows } from '@/lib/chat-folders.ts';

/** Ce qu'une ligne de section dessine. Le plus petit dénominateur des sept. */
export type DynamicRow = {
  id: string;
  name: string;
  /**
   * Cette ligne appelle-t-elle la personne ? Elle décide de la COULEUR du
   * point, quand la section en dessine un — rouge si oui, gris sinon.
   *
   * Absente, la ligne est grise : c'est le cas de RECENTS, dont toutes les
   * demandes ont déjà reçu une réponse.
   */
  calls?: boolean;
  /**
   * Cette ligne TRAVAILLE en ce moment : le point devient lime et bat, comme
   * partout où le produit dit « ça tourne » (`LiveDot`). C'est le point des
   * agents sur la planche 25:1062 (20/09).
   */
  running?: boolean;
  /** L'infobulle, quand elle dit plus que le nom. */
  title?: string;
};

export default function SidebarDynamicList({
  testId,
  read,
  hrefOf,
  empty,
  seeAll,
  seeAllAlways = false,
  dot = false,
  active = true,
}: {
  /** Nomme la section pour les tests et les parcours. */
  testId: string;
  /**
   * La lecture, BORNÉE par l'appelant. Elle doit être stable d'un rendu à
   * l'autre — sans quoi le sondage repartirait sans fin.
   */
  read: (
    limit: number,
  ) => Promise<
    { ok: true; data: readonly DynamicRow[] } | { ok: false; code: string; message: string }
  >;
  /** Où mène une ligne. */
  hrefOf: (row: DynamicRow) => string;
  /** La phrase du cadre en pointillés, quand la lecture a répondu « rien ». */
  empty: ReactNode;
  /**
   * Où mène « See all », et seulement quand la lecture a rendu la ligne de
   * trop. ABSENT quand la section n'a pas de page derrière elle.
   */
  seeAll?: string;
  /**
   * « See all » est rendu MÊME sous le plafond.
   *
   * Le cas des espaces de travail, et le seul : `/spaces` porte plus que la
   * liste — le bouton « New project » et sa table — donc il reste quelque
   * chose à y voir avec deux projets. Partout ailleurs, sous le plafond, tout
   * est déjà sous les yeux et un lien vers « tout » mènerait aux mêmes lignes.
   */
  seeAllAlways?: boolean;
  /**
   * La section dessine-t-elle un POINT devant ses lignes ?
   *
   * La planche en met sur PROJECTS, sur RECENTS et sur les AGENTS (celui des
   * agents dit « il travaille », en lime), et n'en met AUCUN sur CRON ni sur
   * WEBHOOKS. C'est une propriété de la section, pas de la ligne : un point
   * gris par défaut aurait mis une puce devant des lignes que la planche
   * laisse nues.
   */
  dot?: boolean;
  /** La section est-elle dépliée ? À faux, aucune requête ne part. */
  active?: boolean;
}) {
  const lire = useCallback(() => read(FOLDER_THREADS_PROBE), [read]);
  const { rows, erreur } = useSidebarRead<DynamicRow>(lire, active);
  // La ligne de l'endroit où l'on EST s'allume comme une entrée de menu
  // (Quentin, 20/09 : « la sélection se fait, mais rien ne le montre »). Le
  // même repère que `SidebarLink` : la route égale l'adresse de la ligne, ou
  // commence par elle.
  const pathname = usePathname();

  const { rows: lignes, hasMore } =
    rows === null ? { rows: null, hasMore: false } : unfoldedRows(rows);

  // ⚠️ « SEE ALL » SURVIT AUX TROIS ABSENCES quand la section en a un en
  // permanence. C'est tout l'intérêt du cas : `/spaces` n'est plus atteignable
  // que par cette ligne, et elle disparaissait avec la liste sur une base
  // vide — c'est-à-dire précisément sur l'installation neuve où l'on va
  // créer son premier projet. Le parcours Playwright l'a dit avant un humain.
  const voirTout = seeAll !== undefined && (hasMore || seeAllAlways) && (
    <SidebarRow href={seeAll} title="See all" depth="thread" testId={`see-all-${testId}`}>
      <span className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 truncate leading-5 italic">See all</span>
      <ArrowRight size={12} data-testid="see-all-arrow" className="h-3 w-3 shrink-0 text-ink-3" />
    </SidebarRow>
  );

  return (
    <div className="flex flex-col gap-0" data-testid={`sidebar-list-${testId}`}>
      {erreur !== null ? (
        <p className={SIDEBAR_NOTE}>{erreur}</p>
      ) : lignes === null ? (
        <p className={SIDEBAR_NOTE}>Loading</p>
      ) : lignes.length === 0 ? (
        <SidebarEmpty>{empty}</SidebarEmpty>
      ) : (
        lignes.map((r) => (
          <SidebarRow
            key={r.id}
            href={hrefOf(r)}
            title={r.title ?? r.name}
            depth="thread"
            active={pathname === hrefOf(r) || pathname.startsWith(`${hrefOf(r)}/`)}
            markCurrent
            testId={`sidebar-row-${testId}`}
          >
            {dot && r.running === true ? (
              <span
                className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
                data-testid="running-dot"
              >
                <LiveDot variant="lime" size="md" />
              </span>
            ) : dot ? (
              <ThreadDot thread={{ waiting: r.calls ?? false, running: false, unread: false }} />
            ) : (
              // Une place vide de la largeur d'un point : les noms s'alignent
              // sur ceux des sections qui en portent un, sans rien mettre devant
              // eux. C'est ce que la planche dessine sur CRON et sur les agents.
              <span className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="flex-1 truncate leading-5">{r.name}</span>
          </SidebarRow>
        ))
      )}
      {voirTout}
    </div>
  );
}

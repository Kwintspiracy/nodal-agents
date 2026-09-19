'use client';

// WorkspacesFolder — le dossier « Workspaces » du panneau Work (#230, décision
// du propriétaire du 19/09/2026 au soir).
//
// UN CANAL DE PLUS, et pas une ligne à part : il se plie et se déplie du même
// geste qu'un dossier de Channels — cliquer le nom plie, le chevron aussi, le
// survol éclaire la ligne entière chevron compris — et son sous-menu a la même
// forme. C'est pour cela qu'il monte les MÊMES primitifs (`InboxFolder`,
// `SidebarCaret`, `SidebarRow`) plutôt que d'en redessiner un jeu : deux
// dossiers qui se plient différemment dans la même colonne se remarquent tout
// de suite.
//
// Ce qu'il montre est la liste des PROJETS, les dix derniers par date
// d'enregistrement, chacun ouvrant sa page.
//
// ⚠️ SON « SEE ALL » EST TOUJOURS LÀ, et c'est la seule différence avec un
// dossier de canal (décision de l'orchestrateur, 19/09/2026 au soir). Ailleurs
// il n'apparaît qu'au-delà du plafond, parce qu'en dessous tout est déjà sous
// les yeux et qu'un lien vers « tout » mènerait aux mêmes lignes. Ici c'est
// faux : `/spaces` porte plus que la liste — le bouton « New project » et sa
// table — donc il reste quelque chose à y voir même avec deux projets. Et
// comme un dossier ne navigue pas (#206), sans cette ligne la page ne serait
// plus atteignable depuis la barre.
//
// ⚠️ IL NE VIT PAS DANS `ChatFolderGroup`. Un dossier de Channels est un
// endroit d'où des conversations ARRIVENT ; un projet est un endroit où l'on
// TRAVAILLE. Les mêler dans la même boucle aurait demandé au calcul des
// dossiers (`lib/chat-folders.ts`) de connaître les projets, et à sa pastille
// de compter deux choses différentes.
//
// ⚠️ SA LECTURE EST PARESSEUSE, comme celle des sous-menus : replié, il ne
// demande rien. Elle part au premier dépliage et se relit ensuite sur la
// cadence de la barre, pour la même raison que le sous-menu d'un dossier
// (#223) : un projet enregistré depuis un autre onglet apparaît sans qu'on
// recharge.
//
// ⚠️ SON REPLI N'EST PAS RETENU d'une session à l'autre — état de composant,
// replié au rechargement. C'est la PARITÉ avec les dossiers de canaux, qui ne
// le retiennent pas non plus : deux dossiers voisins qui se souviendraient
// différemment se remarqueraient tout de suite. Le jour où on veut cette
// mémoire, elle se fait pour les deux.

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ArrowRight, CardsThree } from '@phosphor-icons/react';
import InboxFolder from './ui/InboxFolder';
import SidebarCaret from './ui/SidebarCaret';
import SidebarRow, { SIDEBAR_NOTE } from './ui/SidebarRow';
import { listSidebarProjectsAction, type SidebarProjectRow } from '@/lib/project-actions.ts';
import { FOLDER_THREADS_PROBE, unfoldedRows } from '@/lib/chat-folders.ts';
import { usePolling, SIDEBAR_POLL_MS } from '@/lib/use-polling';

/** Où mène le dossier, et son « See all » : la page des espaces de travail. */
const HREF = '/spaces';

export default function WorkspacesFolder() {
  const pathname = usePathname();
  const [ouvert, setOuvert] = useState(false);
  /** `null` = la lecture n'a pas encore répondu. Un tableau vide est un fait. */
  const [projets, setProjets] = useState<readonly SidebarProjectRow[] | null>(null);
  /** Ce que la lecture a répondu quand elle a échoué. Jamais un silence. */
  const [erreur, setErreur] = useState<string | null>(null);

  /**
   * L'ÂGE de la lecture qu'on attend — la MÊME garde que le sous-menu des
   * dossiers (Reviewer C, passe 2 de la PR #223), et pour la même raison : une
   * navigation et un tour d'horloge peuvent avoir deux lectures en vol, et
   * rien n'ordonne leurs réponses.
   */
  const age = useRef(0);
  useEffect(() => {
    return () => {
      age.current += 1;
    };
  }, []);

  const relire = useCallback(async (): Promise<void> => {
    const mien = (age.current += 1);
    const r = await listSidebarProjectsAction(FOLDER_THREADS_PROBE);
    if (mien !== age.current) return;
    if (r.ok) {
      setProjets(r.data);
      setErreur(null);
      return;
    }
    setErreur(r.message);
  }, []);

  /**
   * Replié, il n'y a rien à l'écran à tenir à jour : aucune lecture ne part.
   * `pathname` est un DÉCLENCHEUR voulu, pas une donnée lue — il change
   * l'identité de la fonction à chaque navigation, ce qui relance l'effet.
   */
  const relireSiOuvert = useCallback(async (): Promise<void> => {
    if (!ouvert) return;
    await relire();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ouvert, relire, pathname]);
  usePolling(relireSiOuvert, SIDEBAR_POLL_MS, true);

  // Seules les LIGNES sont coupées au plafond : le « See all » de ce dossier
  // ne dépend pas du nombre, il est toujours rendu.
  const rows = projets === null ? null : unfoldedRows(projets).rows;

  return (
    <div>
      <InboxFolder
        folderKey="workspaces"
        label="Workspaces"
        icon={<CardsThree size={14} className="h-3.5 w-3.5" />}
        waiting={0}
        running={false}
        // Le dossier est ACTIF sur la page des espaces et sur celle d'un
        // projet : c'est ce que sa ligne ouvre, et c'est là qu'on se trouve.
        active={pathname === HREF || pathname.startsWith(`${HREF}/`)}
        expanded={ouvert}
        onToggle={() => setOuvert((o) => !o)}
        caret={
          <SidebarCaret
            open={ouvert}
            onToggle={() => setOuvert((o) => !o)}
            label="Workspaces"
            testId="folder-caret-workspaces"
          />
        }
      />
      {ouvert && (
        <div className="flex flex-col gap-0.5 pt-0.5" data-testid="folder-threads-workspaces">
          {erreur !== null ? (
            <p className={SIDEBAR_NOTE}>{erreur}</p>
          ) : rows === null ? (
            <p className={SIDEBAR_NOTE}>Loading</p>
          ) : rows.length === 0 ? (
            <p className={SIDEBAR_NOTE}>Nothing here yet</p>
          ) : (
            rows.map((p) => (
              <SidebarRow
                key={p.id}
                href={`${HREF}/${p.id}`}
                title={p.name}
                depth="thread"
                testId="folder-thread-workspaces"
              >
                {/* Une place vide de la largeur d'un point : les noms de
                    projets s'alignent sur les titres de fils des autres
                    sous-menus, sans rien mettre devant eux. */}
                <span className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1 truncate leading-5">{p.name}</span>
              </SidebarRow>
            ))
          )}
          {/* TOUJOURS, et pas seulement au-delà du plafond : voir l'en-tête.
              `/spaces` porte plus que la liste, et un dossier ne navigue pas. */}
          <SidebarRow href={HREF} title="See all" depth="thread" testId="folder-see-all-workspaces">
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
      )}
    </div>
  );
}

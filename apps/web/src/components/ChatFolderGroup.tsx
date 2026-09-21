'use client';

// ChatFolderGroup — le groupe « Chat folders », sous le lien Chat (#135).
//
// Un composant à part, et pas quelques lignes de plus dans `Sidebar`, pour une
// raison précise : il lit `useSearchParams`, que Next veut voir sous une
// frontière `<Suspense>`. L'isoler laisse la barre latérale entière rendre
// sans attendre, et le groupe apparaît à l'intérieur de sa propre frontière.
//
// Tout ce qui décide — quels dossiers existent, leur compte, leur état actif —
// vit dans `lib/chat-folders.ts`, pur et testé. Ici, il ne reste que le rendu.
//
// Depuis le 18/09/2026, chaque dossier se DÉPLIE (Quentin) : son chevron
// montre ses cinq derniers fils, puis un « See all » vers sa liste. Ce ne sont
// pas d'autres lignes que celles de la liste : `listFolderThreadsAction`
// appelle les MÊMES lectures que la page du dossier, et rend les mêmes titres
// dans le même ordre.
//
// ⚠️ LA LECTURE EST PARESSEUSE, ET ELLE COUVRE TOUS LES DOSSIERS. Un dossier
// est replié par défaut : charger ses fils à chaque rendu de la barre ferait
// payer à toutes les pages du tableau de bord un menu que personne n'a ouvert.
// Elle part donc au PREMIER dépliage, et rapporte les fils de tous les
// dossiers d'un coup — jamais une requête par dossier, qui redeviendrait un
// N+1 au premier canal ajouté.
//
// ⚠️ ELLE SE RELIT, ET ELLE NE LE FAISAIT PAS (19/09/2026, retour du
// propriétaire sur #223 : « les états dans la sidebar ne se mettent pas à
// jour, il faut rafraîchir la page »). Le sous-menu lisait UNE FOIS, au
// premier dépliage, et gardait cet instantané pour la vie de l'onglet : le
// point d'un fil qu'on venait d'ouvrir restait rouge, et un message arrivé
// après coup n'allumait rien. Deux déclencheurs le corrigent, et aucun n'est
// une seconde source de données — c'est la MÊME action, celle qui remplit
// déjà le sous-menu :
//
//   - À CHAQUE CHANGEMENT DE PAGE. Ouvrir un fil écrit son marqueur de lecture
//     côté serveur (`getConversationThreadAction`) ; la barre latérale, elle,
//     est cliente et survit à la navigation, donc rien ne la prévenait. Elle
//     relit maintenant quand `pathname` change — c'est-à-dire juste après que
//     le rendu serveur du fil a posé le marqueur — et le point s'éteint sans
//     rechargement.
//   - SUR LA CADENCE DES DEUX AUTRES SIGNAUX. La pastille corail et le point
//     vert viennent de `ChatFoldersProvider` et d'`ApprovalsProvider`, qui
//     relisent toutes les 15 s par `usePolling` (sauté quand l'onglet est
//     caché, repris quand il revient). Le sous-menu prend la MÊME cadence et
//     le MÊME hook : un non-lu qui s'allumerait plus vite que la pastille
//     ferait dire deux heures différentes à la même barre.
//
// La relecture reste bornée au cas utile : elle ne tourne QUE pendant qu'un
// dossier est déplié. Tout replier l'arrête ; rouvrir la relance, et par une
// lecture immédiate plutôt que par l'instantané d'il y a un quart d'heure.

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  ArrowRight,
  ChatCircleText,
  DiscordLogo,
  PaperPlaneTilt,
  PlugsConnected,
  SlackLogo,
  TelegramLogo,
  WhatsappLogo,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import InboxFolder from './ui/InboxFolder';
import SidebarCaret from './ui/SidebarCaret';
import SidebarRow, { SIDEBAR_NOTE } from './ui/SidebarRow';
import ThreadDot from './ui/ThreadDot';
import RowActions from './sidebar/RowActions';
import { useApprovals } from './ApprovalsProvider';
import { useChatFolders } from './ChatFoldersProvider';
import { chatFolders, unfoldedRows, DASHBOARD_FOLDER, MCP_FOLDER } from '@/lib/chat-folders.ts';
import {
  listFolderThreadsAction,
  type FolderThreadsSnapshot,
} from '@/lib/folder-threads-actions.ts';
import { usePolling, SIDEBAR_POLL_MS } from '@/lib/use-polling';

/**
 * L'icône d'un dossier. Les logos de marque quand le paquet d'icônes en a un —
 * c'est ce qu'on reconnaît du coin de l'œil — et l'avion en papier pour un
 * canal qu'il ne connaît pas : un dossier sans icône se lit comme une ligne
 * cassée.
 */
const FOLDER_ICON: Readonly<Record<string, PhosphorIcon>> = {
  telegram: TelegramLogo,
  slack: SlackLogo,
  discord: DiscordLogo,
  whatsapp: WhatsappLogo,
  // Une bulle AVEC DES LIGNES, et pas la bulle nue que portait « Channels »
  // juste au-dessus (Quentin, 19/09/2026) : le parent et son premier enfant
  // avaient la même icône. « Channels » a pris un bac ; celui-ci garde la
  // bulle, parce que c'est bien ici qu'on parle.
  [DASHBOARD_FOLDER]: ChatCircleText,
  // Une prise branchée, et pas une bulle : ce dossier n'est pas un endroit où
  // l'on parle, c'est ce qui arrive quand une machine se branche au produit.
  [MCP_FOLDER]: PlugsConnected,
};

export default function ChatFolderGroup() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { pending } = useApprovals();
  const { channels, running, externalRuns, deliverablesToCheck } = useChatFolders();

  // Quels dossiers sont dépliés. Repliés par défaut : le menu montre les
  // ENDROITS, pas leur contenu, et dix fils par dossier rendraient la barre
  // plus longue que l'écran dès le deuxième canal branché.
  //
  // ⚠️ SAUF « NODAL CHATS » (#258). La planche v2 le dessine OUVERT, ses dix
  // derniers fils sous les yeux et un « See all » dessous, pendant que
  // Telegram, Discord, WhatsApp et MCP restent pliés. C'est le seul dossier
  // dont on vient : les conversations du tableau de bord sont celles qu'on
  // ouvre en arrivant, et les replier faisait commencer chaque visite par un
  // clic. Les autres canaux, eux, sont des endroits où l'on va.
  const [deplies, setDeplies] = useState<Readonly<Record<string, boolean>>>({
    [DASHBOARD_FOLDER]: true,
  });
  const [threads, setThreads] = useState<FolderThreadsSnapshot | null>(null);
  /** Ce que la lecture a répondu quand elle a échoué. Jamais un silence. */
  const [erreur, setErreur] = useState<string | null>(null);

  /**
   * Y A-T-IL UN SOUS-MENU À TENIR À JOUR ? Déduit des dossiers ouverts, et pas
   * gardé dans son propre état (Reviewer C, passe 2 de la PR #223).
   *
   * Un drapeau « on a déplié au moins une fois » ne redescendait jamais : la
   * personne repliait tout et le sondage continuait de tourner pour un menu
   * que plus personne ne regardait. Déduit, il s'éteint au dernier repli et se
   * rallume au dépliage suivant — avec une lecture immédiate, donc un
   * sous-menu frais plutôt que l'instantané d'il y a un quart d'heure.
   *
   * C'est un BOOLÉEN, et c'est ce qui le rend gratuit : replier un dossier
   * pendant qu'un autre reste ouvert ne le change pas, donc ne relance rien.
   */
  const suivi = Object.values(deplies).some((ouvert) => ouvert);

  /**
   * L'ÂGE de la lecture qu'on attend. Une réponse ne s'affiche que si elle est
   * encore celle-là (Reviewer C, passe 2 de la PR #223).
   *
   * Le constat était qu'une lecture en vol n'est pas annulée au démontage, et
   * que `setThreads` s'exécute alors sur un composant démonté. Un simple
   * drapeau « démonté » l'aurait couvert, mais il n'aurait rien prouvé : sous
   * React 19, une mise à jour d'état sur un composant démonté est un non-
   * événement silencieux, et aucun test ne peut l'observer.
   *
   * Un âge couvre le même cas ET un second, celui-là bien visible : DEUX
   * lectures peuvent être en vol en même temps — celle qu'une navigation
   * vient de lancer et celle du tour d'horloge — et rien ne garantit l'ordre
   * des réponses. Sans cet âge, la plus ancienne qui revient en dernier
   * réécrit le sous-menu avec un état périmé.
   *
   * Le démontage périme donc tout ce qui est en vol, par le même chemin.
   */
  const age = useRef(0);
  useEffect(() => {
    return () => {
      age.current += 1;
    };
  }, []);

  const relire = useCallback(async (): Promise<void> => {
    const mien = (age.current += 1);
    const r = await listFolderThreadsAction();
    // Périmée : l'écran est démonté, ou une lecture plus récente est partie
    // depuis. Dans les deux cas il n'y a rien à dessiner avec ça.
    if (mien !== age.current) return;
    if (r.ok) {
      setThreads(r.data);
      // Une lecture qui repasse efface le message de la précédente : sinon le
      // sous-menu garderait sous les yeux une panne déjà réparée.
      setErreur(null);
      return;
    }
    // Un échec se DIT sous le dossier ouvert, et la relecture suivante le
    // retente : un sous-menu vide se lirait comme « aucun fil ici ».
    setErreur(r.message);
  }, []);

  /**
   * La relecture, telle que la barre la déclenche — UN SEUL chemin pour les
   * deux déclencheurs.
   *
   * `pathname` est une dépendance VOULUE, et elle ne sert pas au calcul : elle
   * change l'identité de cette fonction à chaque navigation, ce qui relance
   * l'effet de `usePolling` et, avec `immediate`, refait la lecture sur-le-
   * champ. C'est ce qui éteint le point du fil qu'on vient d'ouvrir — son
   * marqueur a été écrit par le rendu serveur de la page du fil, et ce
   * changement de chemin arrive après.
   *
   * Le même hook tient l'autre moitié : l'intervalle de 15 s allume le point
   * d'un fil qui reçoit pendant qu'on regarde ailleurs, saute les tours quand
   * l'onglet est caché, et relit dès qu'il revient.
   *
   * `immediate` ne coûte rien tant qu'aucun dossier n'est déplié : la garde
   * rend la main avant toute requête.
   */
  const relireSiSuivi = useCallback(async (): Promise<void> => {
    if (!suivi) return;
    await relire();
    // `pathname` est le DÉCLENCHEUR de la relecture, pas une donnée qu'elle
    // lit : la règle le voit comme inutile, et il est au contraire tout le
    // sujet. Le retirer rendrait la barre latérale de nouveau figée entre deux
    // tours d'horloge (#223).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suivi, relire, pathname]);
  usePolling(relireSiSuivi, SIDEBAR_POLL_MS, true);

  const basculer = (key: string): void => {
    setDeplies((etat) => ({ ...etat, [key]: etat[key] !== true }));
  };

  const folders = chatFolders({
    channels,
    // CE QUI ATTEND LA PERSONNE, ses trois sources mises bout à bout (#255) :
    // une approbation en attente, une question posée, et désormais un livrable
    // qui attend un regard. La règle qui range chaque entrée dans un dossier
    // est la même pour les trois — `folderOfWork`, dans chat-folders.ts — et
    // c'est pour cela qu'une simple concaténation suffit ici.
    waiting: [...pending, ...deliverablesToCheck],
    running,
    externalRuns,
    pathname,
    folderParam: searchParams.get('folder'),
  });

  return (
    <div className="flex flex-col gap-0" data-testid="chat-folders">
      {folders.map((f) => {
        const Icon = FOLDER_ICON[f.key] ?? PaperPlaneTilt;
        const ouvert = deplies[f.key] === true;
        // `null` = la lecture n'a pas encore répondu. Un dossier sans fil, lui,
        // rend un tableau vide : les deux ne se disent pas de la même façon.
        //
        // La lecture a demandé UNE LIGNE DE PLUS que ce qu'on dessine : elle
        // est coupée ici, et sa présence est ce qui dit qu'il y en a d'autres.
        const lues = threads === null ? null : (threads[f.key] ?? []);
        const { rows: fils, hasMore } =
          lues === null ? { rows: null, hasMore: false } : unfoldedRows(lues);
        return (
          <div key={f.key}>
            {/* Toute la ligne PLIE le dossier, libellé et chevron (Quentin,
                19/09/2026) : elle ne navigue plus. Le chevron est dans la
                ligne, frère de son bouton, si bien que le survol appartient à
                la ligne entière — il vivait à côté, dans un conteneur sans
                fond, et la ligne s'éclairait à moitié. */}
            <InboxFolder
              folderKey={f.key}
              label={f.label}
              icon={<Icon size={14} className="h-3.5 w-3.5" />}
              // PAS DE NOMBRE SUR UN CANAL (décision du propriétaire,
              // 22/09/2026 : « ne mets pas de puce numérotée sur les
              // channels »). Telegram, Discord, WhatsApp, MCP et tout canal
              // inconnu portaient chacun leur compte ; il n'en reste qu'un, sur
              // « Nodal chats ».
              //
              // Le MODÈLE, lui, continue de compter par dossier : c'est la même
              // règle qui range une attente sous le canal de sa conversation
              // (#135, #148), et c'est elle que prouve `chat-folders.test.ts`.
              // Ce qui change est ce que le menu DESSINE. La case Approvals du
              // rail garde le total, et c'est là qu'on lit combien.
              waiting={f.key === DASHBOARD_FOLDER ? f.waiting : 0}
              running={f.running}
              active={f.active}
              expanded={ouvert}
              onToggle={() => basculer(f.key)}
              caret={
                <SidebarCaret
                  open={ouvert}
                  onToggle={() => basculer(f.key)}
                  label={f.label}
                  testId={`folder-caret-${f.key}`}
                />
              }
            />
            {ouvert && (
              <div className="flex flex-col gap-0 pt-0" data-testid={`folder-threads-${f.key}`}>
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
                      // Le fil OUVERT s'allume (Quentin, 20/09) : la route est
                      // son adresse, ou commence par elle.
                      active={pathname === t.href || pathname.startsWith(`${t.href}/`)}
                      markCurrent
                      // Les trois points, sur un FIL seulement (20/09) : un run
                      // (`/jobs/<id>`) ne se renomme ni ne se supprime d'ici.
                      menu={
                        t.href.startsWith('/chat/') ? (
                          <RowActions
                            kind="conversation"
                            id={t.href.slice('/chat/'.length)}
                            name={t.title}
                            href={t.href}
                            onDone={relire}
                          />
                        ) : undefined
                      }
                      testId={`folder-thread-${f.key}`}
                    >
                      <ThreadDot thread={t} />
                      <span className="flex-1 truncate leading-5">{t.title}</span>
                    </SidebarRow>
                  ))
                )}
                {/* « See all » mène à la liste ENTIÈRE du dossier — depuis le
                    19/09/2026, c'est la SEULE chose du sous-menu qui y mène,
                    le nom du dossier ne servant plus qu'à plier.

                    ET SEULEMENT S'IL Y EN A D'AUTRES (Quentin, 19/09 au soir) :
                    en dessous du plafond, tout est déjà sous les yeux, et un
                    lien vers « tout » qui mènerait aux mêmes lignes ferait
                    promettre au menu ce qu'il montre déjà. Le fait se LIT — la
                    lecture a demandé une ligne de plus — il ne se devine pas. */}
                {hasMore && (
                  <SidebarRow
                    href={f.href}
                    title="See all"
                    depth="thread"
                    testId={`folder-see-all-${f.key}`}
                  >
                    {/* Une place vide de la largeur d'un point : le libellé
                      s'aligne alors sur les titres des fils au-dessus. */}
                    <span className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1 truncate leading-5 font-medium!">See all</span>
                    {/* La flèche dit où l'on va, et elle ferme la ligne comme la
                      flèche d'un lien externe ferme la sienne. */}
                    <ArrowRight
                      size={14}
                      weight="bold"
                      data-testid="see-all-arrow"
                      className="h-3.5 w-3.5 shrink-0 text-ink-4"
                    />
                  </SidebarRow>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

'use client';

// ThreadScroller — la zone qui défile dans un fil, et qui SUIT.
//
// Avant elle, rien ne faisait défiler un fil : `scrollIntoView` et `scrollTop`
// n'existaient nulle part dans les écrans de conversation, seulement dans le
// panneau de logs et l'onboarding, qui l'avaient chacun réimplémenté. Un
// message qui arrivait se posait donc sous le bord bas de la zone visible,
// contre la saisie, et il fallait faire défiler à la main pour lire ce qu'on
// venait de recevoir (Quentin, 08/09/2026).
//
// Deux règles, celles de n'importe quelle messagerie :
//   - à l'ouverture d'un fil, on est EN BAS ;
//   - un message qui arrive fait descendre le fil SEULEMENT si on y était déjà.
//     Sans cette seconde règle, remonter dans l'historique devient impossible :
//     le prochain rafraîchissement vous ramène en bas.
//
// Le suivi s'appuie sur un ResizeObserver et non sur les `children` : le fil
// est rendu par le serveur et rechargé par `LiveRefresh`, mais il grandit aussi
// sans nouveau rendu (une image qui finit de charger, un bloc qu'on déplie).
// Observer la HAUTEUR attrape les deux, et rien d'autre.

// OUVRIR UNE BOÎTE N'ÉTEINT PLUS À MOITIÉ LE SUIVI (19/09).
//
// La règle de Quentin est sans condition : « si je clique sur dérouler, la
// position du scroll ne DOIT PAS bouger ». La PR #160 l'a tenue pour les gros
// blocs seulement. Sa croissance étant celle du lecteur, elle décidait ensuite
// du suivi d'après sa POSITION — `follow = staysAtBottom(el)` — et un bloc plus
// court que `AT_BOTTOM_SLACK_PX` le laissait donc « en bas », suivi allumé.
//
// Ce qui a été MESURÉ le 18/09, sur `/chat/[id]` et sur `/spaces/[id]`, au
// pixel près et aux mêmes chiffres des deux côtés (le composant est partagé) :
// un bloc d'outil à carte lue, sans entrée à citer, grandit de 58 px. Le clic
// ne déplaçait rien ; puis, 1,9 seconde plus tard, `LiveRefresh` ramenait une
// ligne sur un travail qui courait, cette croissance-là tombait hors de la
// fenêtre du geste, et le fil descendait : `scrollTop` 2459 → 2603, la tête de
// la boîte qu'on venait d'ouvrir remontant de 144 px. Du siège du lecteur,
// c'est le clic qui a fait filer la page.
//
// Alors une croissance du lecteur éteint le suivi, quelle que soit sa taille.
// Il se rallume par le seul chemin qui parle de lui : `onScroll`, quand il
// revient en bas.
//
// CE QUE CELA COÛTE, et c'est réel : une réponse qui arrive juste après un
// PETIT dépliage n'est plus suivie ; elle attend sous le pli jusqu'à ce que le
// lecteur redescende. La revue de la PR #160 (Reviewer C, constat P0-2) avait
// plaidé l'inverse — garder le suivi quand le bloc est petit, pour ne pas punir
// une arrivée innocente. L'incident tranche : une vue qui bouge sous les yeux
// de quelqu'un qui vient de cliquer est un défaut qu'il voit, tandis qu'un
// message qui attend sous le pli est un message qu'il trouve en descendant. Le
// second est le moindre mal.
//
// LA RÈGLE EXACTE, et pourquoi il a fallu un drapeau de plus.
//
// Un dépliage se pose en DEUX temps (mesuré : t=0 ms puis t=46 ms), et le
// lecteur peut défiler entre les deux. Deux exigences se croisent alors, et la
// seule fenêtre de temps ne sait pas les départager :
//
//   · sa parole la plus récente doit gagner. S'il descend en bas après son
//     clic, la queue de son propre dépliage ne doit pas rééteindre le suivi
//     qu'il vient de rallumer — sinon il est en bas et plus rien ne le suit
//     (cas B de `thread-unfold-keeps-scroll.spec.ts`, arrivé par la PR #169 et
//     mergé avant celle-ci) ;
//   · sa vue ne doit jamais bouger sous son clic. La première écriture de cette
//     PR clôturait le geste au retour en bas, ce qui rendait la croissance
//     suivante « ordinaire » — donc suivie, donc la boîte ouverte remontait :
//     le même défaut par une autre porte (Reviewer C, passe 2 de la PR #187).
//
// D'où `scrolledSinceGesture`. La croissance du lecteur ne déplace JAMAIS la
// vue ; elle n'éteint le suivi que s'il n'a pas défilé depuis son geste. Les
// deux exigences tiennent, et l'état ajouté est un booléen à deux écrivains :
// le geste le remet à faux, le défilement du lecteur le met à vrai.
//
// CE QUI RESTE IMPARFAIT, ET POURQUOI ON S'ARRÊTE LÀ.
//
// Quatre passes de revue ont trouvé quatre entrelacements dans ce composant de
// vingt lignes. Les deux derniers (revue Codex, PR #48, passe 4) sont des
// courses SOUS LA FRAME : le lecteur défile et le contenu grandit avant que
// l'événement de son geste n'ait été distribué.
//
//   1. Il remonte depuis le bas, le contenu grandit aussitôt : l'observateur ne
//      voit encore aucun mouvement et le ramène en bas, une fois.
//   2. Il redescend jusqu'en bas après avoir lu l'historique, le contenu grandit
//      aussitôt : son geste est jugé sur la nouvelle hauteur, donc « pas en
//      bas », et le suivi reste éteint.
//   3. (18/09, règle du dépliage) Il clique dans le fil SANS rien déplier — une
//      sélection de texte, un lien — et une réponse arrive dans la fenêtre du
//      geste (`READER_GESTURE_WINDOW_MS`) : elle passe pour un bloc qu'il a
//      ouvert, et n'est pas suivie ; elle attend sous le pli jusqu'à son
//      prochain défilement.
//
// Les trois se réparent au geste SUIVANT : dans le premier cas sa remontée est
// alors prise en compte, dans les deux autres son retour en bas rallume le
// suivi. Aucun ne piège durablement, aucun n'a été observé hors d'un test qui
// force la course dans un seul tour de boucle.
//
// Les fermer vraiment demanderait de mémoriser la hauteur en même temps que la
// position et de juger chaque geste à l'aune de ce que le lecteur VOYAIT — donc
// un second état à tenir cohérent, pour un défaut qui s'efface au geste
// suivant. Le remède serait plus fragile que le mal. La technique qui les
// supprime par construction, elle, est le conteneur inversé
// (`flex-direction: column-reverse`), qui laisse le navigateur coller au bas
// sans une ligne de JavaScript — mais elle impose de rendre le fil à l'envers,
// ce qui est un chantier à soi.

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

/**
 * Marge, en pixels, sous laquelle on considère que le lecteur est « en bas ».
 * Pas zéro : un défilement par molette s'arrête rarement au pixel près, et
 * quelques pixels de reste ne veulent pas dire qu'on a remonté l'historique.
 */
export const AT_BOTTOM_SLACK_PX = 64;

/**
 * La variable CSS que ce composant pose sur SON PARENT : la largeur, en pixels,
 * de la gouttière de sa barre de défilement.
 *
 * Pourquoi elle existe (Quentin, 17/09/2026 : « une légère indentation à
 * gauche par rapport au feed, et du coup il dépasse à droite ») : le fil et la
 * saisie centrent chacun une boîte de 760 px, mais la barre de défilement ne
 * vit que dans le fil. Elle lui prend sa largeur, donc son centre n'est plus
 * celui de la saisie, d'une demi-barre — huit pixels de travers sur Windows.
 * La saisie lit cette variable pour se réserver la même gouttière.
 */
export const THREAD_GUTTER_VAR = '--thread-gutter';

/**
 * La gouttière d'une zone de défilement : ce que sa barre lui prend. Zéro
 * quand la barre se superpose au contenu (macOS, mobiles) ou qu'il n'y en a
 * pas. Une fonction pure, pour être éprouvée sans navigateur.
 */
export function scrollbarGutterOf(m: { offsetWidth: number; clientWidth: number }): number {
  return Math.max(0, m.offsetWidth - m.clientWidth);
}

/**
 * Le lecteur est-il « en bas » ? La seule décision de ce composant, sortie ici
 * pour être éprouvée sans navigateur.
 *
 * `scrollHeight - scrollTop - clientHeight` est la distance qui reste sous la
 * zone visible : 0 au ras du bas, la hauteur d'un fil entier tout en haut.
 */
export function staysAtBottom(m: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight < AT_BOTTOM_SLACK_PX;
}

/**
 * Fenêtre, en millisecondes, pendant laquelle une croissance du contenu qui
 * suit un geste du lecteur DANS le fil (un clic, une touche) est la sienne :
 * un bloc qu'il vient de déplier, pas une réponse qui arrive.
 *
 * Quentin, 18/09/2026 : « quand je déroule quoi que ce soit dans un feed, ça
 * déroule vers le haut ; si je clique sur dérouler, la position du scroll ne
 * DOIT PAS bouger et le contenu se déroule vers le bas ». Le fil suivait le
 * bas à CHAQUE croissance ; un bloc ouvert depuis le bas faisait donc filer la
 * zone visible sous ce qu'on venait d'ouvrir.
 */
export const READER_GESTURE_WINDOW_MS = 800;

/**
 * Cette croissance vient-elle du lecteur ? Oui si un geste vient d'avoir lieu
 * dans le fil. Une fonction pure, pour être éprouvée sans navigateur.
 */
export function growthIsTheReaders(m: { gestureAt: number | null; now: number }): boolean {
  return m.gestureAt !== null && m.now - m.gestureAt < READER_GESTURE_WINDOW_MS;
}

export default function ThreadScroller({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  /** Faut-il suivre le bas ? Vrai tant que le lecteur n'a pas remonté. */
  const follow = useRef(true);
  /**
   * La dernière position que NOUS avons écrite, ou `null` si le dernier
   * mouvement vient du lecteur.
   *
   * Pourquoi une POSITION et non un compteur : le navigateur FUSIONNE les
   * événements de défilement d'un même élément (CSSOM View §13.2). On ne sait
   * donc pas combien d'événements suivront nos écritures — un compteur restait
   * armé, ou se vidait sur le geste du lecteur, et l'avalait (revue Codex,
   * PR #48, passes 2 et 3, chacune ayant trouvé un entrelacement de plus).
   *
   * Une position, elle, se compare : l'événement porte celle du lecteur ou la
   * nôtre, quel qu'ait été le nombre d'événements en route.
   */
  const selfScrollTop = useRef<number | null>(null);
  /**
   * L'instant du dernier geste du lecteur DANS le fil (clic, touche). Une
   * croissance qui le suit de près est un bloc qu'il a déplié : elle s'ouvre
   * vers le bas, sous ses yeux, et on ne le déplace pas.
   */
  const gestureAt = useRef<number | null>(null);
  /**
   * Le lecteur a-t-il DÉPLACÉ LA VUE lui-même depuis son geste ?
   *
   * Un seul booléen, et il départage deux situations que la seule fenêtre de
   * temps confond (Reviewer C, passe 2 de la PR #187) :
   *
   *   - il clique et ne bouge pas : la croissance de son bloc doit éteindre le
   *     suivi, sans quoi l'arrivée suivante le descend (le défaut du 18/09) ;
   *   - il clique PUIS descend en bas avant que le bloc n'ait fini de se poser
   *     (un dépliage arrive en deux temps, mesuré t=0 ms puis t=46 ms) : son
   *     défilement est sa parole la plus récente, et la queue de son propre
   *     dépliage n'a pas à la contredire.
   *
   * Dans les DEUX cas, la croissance ne déplace jamais la vue. Ce drapeau ne
   * décide que du sort du suivi.
   */
  const scrolledSinceGesture = useRef(false);

  /**
   * Descendre, sans que notre propre geste passe pour celui du lecteur.
   *
   * On mémorise la POSITION écrite, pas le fait d'avoir écrit. C'est ce qui
   * distingue les deux mécanismes, et la distinction a été payée deux fois :
   *
   *   - un DRAPEAU « c'est nous » armé à chaque écriture restait en attente
   *     d'un événement qui ne venait jamais quand le fil était déjà en bas, et
   *     c'est le geste SUIVANT du lecteur qui se faisait avaler (passe 1) ;
   *   - un COMPTEUR d'événements attendus ne peut pas marcher davantage : le
   *     navigateur FUSIONNE les événements de défilement d'un même élément
   *     (CSSOM View §13.2), donc on ne sait pas combien arriveront (passe 3).
   *
   * La position, elle, se relit à tout moment et ne se consomme pas. L'écriture
   * est synchrone, l'événement asynchrone : lire `scrollTop` juste après
   * l'affectation enregistre où le navigateur nous a réellement laissés — il
   * borne la valeur à ce que le contenu permet — avant que l'événement
   * n'arrive. Toute position différente de celle-là vient de quelqu'un d'autre.
   *
   * L'affectation est donc INCONDITIONNELLE, et ce n'est pas un oubli : une
   * écriture qui ne déplace rien réenregistre la position courante, ce qui est
   * exactement ce qu'on veut mémoriser.
   */
  const scrollToBottom = (el: HTMLDivElement) => {
    el.scrollTop = el.scrollHeight;
    // La position EFFECTIVE après écriture, pas celle qu'on visait : le
    // navigateur borne `scrollTop` à ce que le contenu permet.
    selfScrollTop.current = el.scrollTop;
  };

  // AVANT la peinture : ouvrir un fil sur son dernier message, sans que le
  // lecteur voie passer le haut de l'historique.
  //
  // Ce que la mutation dit de cette ligne, et qu'il faut savoir : la neutraliser
  // NE fait pas rougir la spec `thread-autoscroll` — l'observateur ci-dessous
  // rattrape, parce qu'il émet dès qu'il commence à observer. Elle ne tient donc
  // pas la POSITION, qui est prouvée ailleurs ; elle évite le FLASH, ce
  // qu'aucun test de ce dépôt ne sait mesurer. Elle reste pour ça, et pour rien
  // d'autre.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) scrollToBottom(el);
  }, []);

  // La gouttière, mesurée et posée sur le parent AVANT la peinture, puis
  // remesurée quand la zone change de taille (la barre apparaît ou disparaît
  // avec le contenu ; `scrollbar-gutter: stable` la rend constante, mais rien
  // n'oblige tous les navigateurs à l'honorer). Aucun setState : c'est une
  // écriture DOM, hors de React, et la saisie la lit en CSS.
  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const publish = () => host.style.setProperty(THREAD_GUTTER_VAR, `${scrollbarGutterOf(el)}px`);
    publish();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      host.style.removeProperty(THREAD_GUTTER_VAR);
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observed = el.firstElementChild ?? el;
    const ro = new ResizeObserver(() => {
      // `follow` ne suffit pas : il n'est mis à jour qu'à la RÉCEPTION d'un
      // événement de défilement, et l'observateur peut se déclencher avant que
      // celui du lecteur n'ait été distribué. Sur une arrivée rapide, on
      // ramenait donc en bas quelqu'un qui venait de remonter (revue Codex,
      // PR #48, passe 3 — reproduit par la spec « en vol »).
      //
      // La position tranche sans attendre : si elle n'est plus celle que nous
      // avons écrite, quelqu'un d'autre l'a changée.
      const bougeParLeLecteur =
        selfScrollTop.current !== null && el.scrollTop !== selfScrollTop.current;
      if (bougeParLeLecteur) {
        follow.current = false;
        return;
      }
      // Le lecteur vient de cliquer dans le fil : cette croissance est un bloc
      // qu'il a ouvert. La zone visible ne bouge pas, et le suivi S'ÉTEINT —
      // quelle que soit la taille du bloc. Il se rallume par le seul chemin qui
      // dit quelque chose du lecteur : `onScroll`, quand il revient en bas.
      //
      // Voir l'en-tête de ce fichier, section « ouvrir une boîte n'éteint plus
      // à moitié le suivi », pour ce que ce « non » forcé coûte et pourquoi il
      // est le moindre mal.
      if (growthIsTheReaders({ gestureAt: gestureAt.current, now: performance.now() })) {
        // La vue ne bouge pas — c'est la règle, sans condition. Le SUIVI, lui,
        // ne s'éteint que si le lecteur n'a pas déplacé la vue depuis son
        // geste : s'il l'a fait, son défilement est plus récent que son clic.
        if (!scrolledSinceGesture.current) follow.current = false;
        selfScrollTop.current = null;
        return;
      }
      if (follow.current) scrollToBottom(el);
    });
    ro.observe(observed);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      // Repère stable pour les tests de bout en bout : `.overflow-y-auto` seul
      // désigne aussi le conteneur du layout du dashboard, qui défile lui aussi.
      data-thread-scroller=""
      className={className}
      // En capture : le geste est noté AVANT que le bloc cliqué ne change
      // d'état et ne fasse grandir le fil.
      onPointerDownCapture={() => {
        gestureAt.current = performance.now();
        scrolledSinceGesture.current = false;
      }}
      onKeyDownCapture={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          gestureAt.current = performance.now();
          scrolledSinceGesture.current = false;
        }
      }}
      onScroll={() => {
        const el = ref.current;
        if (!el) return;
        // En bas, quelle qu'en soit la raison : on suit.
        if (staysAtBottom(el)) {
          selfScrollTop.current = null;
          follow.current = true;
          // Il a déplacé la vue LUI-MÊME : la queue de son dépliage ne
          // rééteindra pas le suivi qu'il vient de rallumer. Elle ne le
          // déplacera pas non plus — voir le rappel de l'observateur.
          scrolledSinceGesture.current = true;
          return;
        }
        // Pas en bas, mais la position est EXACTEMENT celle que nous avons
        // écrite : c'est notre propre défilement qui arrive, pas un geste. Le
        // cas se produit quand le contenu grandit sans que le bas soit
        // atteignable d'un coup. Le geste, lui, n'est PAS clos : ce
        // défilement-là n'est pas le sien.
        if (selfScrollTop.current !== null && el.scrollTop === selfScrollTop.current) return;
        // Pas en bas, et la position n'est pas la nôtre : le lecteur a remonté.
        selfScrollTop.current = null;
        follow.current = false;
        scrolledSinceGesture.current = true;
      }}
    >
      {children}
    </div>
  );
}

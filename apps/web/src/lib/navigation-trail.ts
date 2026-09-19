// navigation-trail.ts — le fil des pages de l'app réellement visitées dans cet
// onglet, et la décision que « Back » en tire (#232, 19/09/2026).
//
// Le défaut constaté deux fois dans la même soirée : ouvrir une automation puis
// un de ses runs, « Back » ramenait à Scheduled ; ouvrir un workspace puis une
// de ses conversations, « Back » ramenait à Nodal chats. Chaque page de détail
// codait en dur sa destination, donc le même écran atteint par deux chemins
// repartait toujours au même endroit — le mauvais, pour l'un des deux.
//
// La règle : « Back » revient à la page d'où l'on vient quand c'est une page de
// l'app ; sinon (lien collé dans un nouvel onglet, premier chargement) au
// parent déterministe que la page nomme. Ce module tient le fil et rend la
// décision ; il ne touche ni au routeur ni au DOM (les deux fonctions qui
// lisent `sessionStorage` et `history` sont en bas, isolées, et tout le reste
// est pur donc prouvable sans navigateur).

/** Une page visitée : son chemin, et la clé de l'entrée d'historique qui la porte. */
export type TrailEntry = { path: string; key: number };

/** Où le fil vit — par ONGLET (`sessionStorage`), jamais partagé entre onglets. */
export const TRAIL_STORAGE_KEY = 'nodal.nav-trail';

/**
 * Combien d'entrées on garde. Quelques-unes suffisent : la décision ne regarde
 * que la dernière et l'avant-dernière ; le reste n'est là que pour survivre à
 * un aller-retour. Un fil non borné grossirait sans jamais servir.
 */
export const TRAIL_MAX = 8;

/** La clé posée dans `history.state` pour reconnaître une entrée déjà vue. */
export const TRAIL_STATE_KEY = 'nodalTrailKey';

/**
 * Les routes qui ne sont PAS des pages de l'app : on n'y revient jamais par
 * « Back » (revenir sur `/login` après s'être connecté, ou sur l'onboarding
 * après l'avoir fini, renverrait la personne sur un écran qu'elle vient de
 * quitter pour de bon).
 */
const HORS_APP = ['/login', '/onboarding'] as const;

/**
 * Une page de l'app, et rien d'autre : un chemin absolu d'un seul slash. La
 * double barre (`//exemple.com`) est une URL de protocole relatif — le
 * navigateur la suivrait vers un autre site. Le fil vit dans `sessionStorage`,
 * donc éditable : ce filtre vaut à l'écriture ET à la lecture.
 */
export function isAppPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  return !HORS_APP.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Relit le fil sérialisé, en écartant tout ce qui n'est pas une entrée valide. */
export function parseTrail(raw: string | null): TrailEntry[] {
  if (raw === null || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const trail: TrailEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const { path, key } = item as { path?: unknown; key?: unknown };
    if (typeof path !== 'string' || typeof key !== 'number' || !Number.isFinite(key)) continue;
    if (!isAppPath(path)) continue;
    trail.push({ path, key });
  }
  return trail.slice(-TRAIL_MAX);
}

export function serializeTrail(trail: readonly TrailEntry[]): string {
  return JSON.stringify(trail);
}

/**
 * Ce que le fil devient quand la personne arrive sur `path`.
 *
 * `stampedKey` est la clé trouvée dans `history.state` : elle n'est là que si
 * cette entrée d'historique a DÉJÀ été parcourue, c'est-à-dire que la personne
 * y est revenue par le bouton Back du navigateur (ou l'a rechargée). Dans ce
 * cas on tronque le fil jusqu'à cette entrée au lieu d'en ajouter une : sans
 * cela le fil dirait « tu viens de B » alors que l'historique, lui, est déjà
 * repassé avant B, et « Back » sauterait hors de l'app.
 *
 * `key` vaut `null` quand il n'y a rien de neuf à marquer dans l'historique.
 */
export function recordVisit(
  trail: readonly TrailEntry[],
  path: string,
  stampedKey: number | null,
): { trail: TrailEntry[]; key: number | null } {
  if (!isAppPath(path)) return { trail: [...trail], key: null };

  if (stampedKey !== null) {
    const seen = trail.findIndex((e) => e.key === stampedKey && e.path === path);
    if (seen >= 0) return { trail: trail.slice(0, seen + 1), key: null };
  }

  const last = trail[trail.length - 1];
  // Un re-rendu sur le MÊME chemin ne crée pas d'entrée : le fil compterait
  // deux fois la page courante et « Back » ne bougerait plus.
  if (last !== undefined && last.path === path) return { trail: [...trail], key: null };

  const key = trail.reduce((max, e) => (e.key > max ? e.key : max), -1) + 1;
  return { trail: [...trail, { path, key }].slice(-TRAIL_MAX), key };
}

/**
 * Ce que « Back » doit faire depuis `currentPath`, au vu du fil.
 *
 * `null` = aucune page précédente connue dans cet onglet ⇒ l'appelant va au
 * parent déterministe. `back` = la page précédente est bien l'entrée
 * d'historique juste avant (clés qui se suivent), donc on dépile vraiment :
 * le navigateur rend la position de défilement et ne gonfle pas l'historique.
 * `push` = elle est ailleurs dans l'historique, alors on y va par l'avant —
 * un `history.back()` y tomberait à côté.
 */
export function backTarget(
  trail: readonly TrailEntry[],
  currentPath: string,
): { mode: 'back' } | { mode: 'push'; path: string } | null {
  const last = trail[trail.length - 1];
  if (last === undefined) return null;

  if (last.path !== currentPath) {
    // Le fil n'a pas encore enregistré la page courante (clic avant que l'effet
    // du fil n'ait tourné) : la dernière entrée EST la page d'où l'on vient.
    // On y va par l'avant, car on ne sait rien de la position dans l'historique.
    return isAppPath(last.path) ? { mode: 'push', path: last.path } : null;
  }

  const previous = trail[trail.length - 2];
  if (previous === undefined || previous.path === currentPath) return null;
  if (!isAppPath(previous.path)) return null;
  return previous.key === last.key - 1 ? { mode: 'back' } : { mode: 'push', path: previous.path };
}

// ─── Les deux seules portes vers le navigateur ────────────────────────────────

/** `sessionStorage` peut jeter (navigation privée, stockage bloqué) : jamais fatal. */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readTrail(): TrailEntry[] {
  const s = storage();
  if (s === null) return [];
  try {
    return parseTrail(s.getItem(TRAIL_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function writeTrail(trail: readonly TrailEntry[]): void {
  const s = storage();
  if (s === null) return;
  try {
    s.setItem(TRAIL_STORAGE_KEY, serializeTrail(trail));
  } catch {
    /* le fil est un confort : un stockage plein ne casse pas la navigation */
  }
}

/** La clé déjà posée sur l'entrée d'historique courante, s'il y en a une. */
export function readStampedKey(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const state = window.history.state as Record<string, unknown> | null;
    const key = state?.[TRAIL_STATE_KEY];
    return typeof key === 'number' && Number.isFinite(key) ? key : null;
  } catch {
    return null;
  }
}

/**
 * Marque l'entrée d'historique courante. On FUSIONNE avec l'état existant :
 * l'App Router de Next range son propre arbre là-dedans, l'écraser casserait
 * la navigation.
 *
 * Next 16.3 remplace `history.replaceState` par une version qui, lorsque
 * l'état porte déjà son drapeau `__NA` — c'est le cas ici, puisqu'on part de
 * l'état existant —, appelle la fonction d'origine SANS rien renvoyer au
 * routeur (`app-router.js`, la garde « Avoid a loop when Next.js internals
 * trigger pushState/replaceState »). Pas de re-rendu, pas de boucle ; et son
 * écouteur `popstate` continue de voir `__NA`, donc il ne recharge pas la page.
 * On ne passe pas d'URL : seul l'état change.
 */
export function stampKey(key: number): void {
  if (typeof window === 'undefined') return;
  try {
    const state = (window.history.state ?? {}) as Record<string, unknown>;
    window.history.replaceState({ ...state, [TRAIL_STATE_KEY]: key }, '');
  } catch {
    /* rien à faire : le fil retombe alors sur le mode « push », qui est juste */
  }
}

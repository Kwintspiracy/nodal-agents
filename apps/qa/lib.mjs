// apps/qa/lib.mjs — les décisions du portail, isolées pour être PROUVÉES.
//
// Tout ce qui vit ici transforme des données en verdicts affichés : la colonne
// d'une carte, l'état d'une CI, le résultat d'un parcours. C'est exactement ce
// qu'un portail ne doit pas se tromper, et c'était jusqu'ici noyé dans
// `collect.mjs`, hors de portée d'un test.
//
// Le portail se dénonçait lui-même à 0 % de couverture. Il avait raison, et
// une revue Codex a trouvé six erreurs de jugement dans ces quelques
// fonctions — dont deux qui le faisaient MENTIR : une CI annulée affichée
// verte, et des tests ignorés comptés comme rouges.

// ─── L'état d'une CI ──────────────────────────────────────────────────────────

/**
 * Le vert n'est accordé qu'à ce qui a EXPLICITEMENT réussi.
 *
 * La première version disait « pas d'échec et rien en cours ⇒ vert ». Trois cas
 * passaient au travers :
 *   - une exécution `CANCELLED` (il y en a eu quatre dans la seule journée du
 *     10/09, chaque push annulant la précédente) ;
 *   - un `TIMED_OUT` ou un `ACTION_REQUIRED`, terminés sans succès ;
 *   - un contexte de statut ancien (`state: 'PENDING'`), qui ne porte pas de
 *     champ `status` et tombait donc dans le vert.
 *
 * GitHub mélange deux formes dans `statusCheckRollup` : les *check runs*
 * (`status` + `conclusion`) et les *status contexts* (`state` seul). Les deux
 * sont lues ici, sinon la moitié des contrôles est jugée sur un champ absent.
 */
export function etatCi(rollup) {
  const controles = rollup ?? [];
  if (controles.length === 0) return null;

  const SUCCES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
  const EN_COURS = new Set([
    'PENDING',
    'QUEUED',
    'IN_PROGRESS',
    'WAITING',
    'REQUESTED',
    'EXPECTED',
  ]);

  let enCours = false;
  for (const c of controles) {
    // Un check run terminé porte `conclusion` ; un status context porte `state`.
    const brut = String(c.conclusion ?? c.state ?? c.status ?? '').toUpperCase();
    if (SUCCES.has(brut)) continue;
    if (EN_COURS.has(brut) || EN_COURS.has(String(c.status ?? '').toUpperCase())) {
      enCours = true;
      continue;
    }
    // Tout le reste — FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE,
    // ERROR, et n'importe quel état futur — n'est PAS un succès. Le défaut est
    // le rouge, jamais le vert : un tableau qui verdit ce qu'il ne comprend pas
    // ment sur le seul point qui compte.
    return 'rouge';
  }
  return enCours ? 'en cours' : 'vert';
}

// ─── La colonne d'une carte ───────────────────────────────────────────────────

/**
 * Déduite de faits, jamais saisie.
 *
 * `CLOSED` sans merge n'est PAS « en review » : c'est une PR abandonnée, et la
 * compter parmi celles qui attendent un merge gonfle une colonne qui doit
 * rester un appel à l'action. Le cas est réel — la PR #2 de Snyk, fermée sans
 * merge, s'affichait « En review » (revue Codex, PR #51).
 */
export function colonneDeCarte(carte) {
  if (carte.type === 'pr') {
    if (carte.etat === 'MERGED') return 'Fait';
    if (carte.etat === 'CLOSED') return 'Abandonné';
    return 'En review';
  }
  if (carte.etat !== 'OPEN') return 'Fait';
  const etiquettes = carte.etiquettes ?? [];
  if (etiquettes.includes('décision')) return 'À faire';
  if (etiquettes.includes('test')) return 'À tester';
  return 'En cours';
}

export const COLONNES = ['À faire', 'En cours', 'En review', 'À tester', 'Fait'];

// ─── Le résultat d'un parcours ────────────────────────────────────────────────

/**
 * Les quatre sorts d'un cas de test, gardés SÉPARÉS.
 *
 * La première version faisait `vert = tous les essais sont passés`, ce qui
 * mettait dans le même sac le rouge et l'ignoré. Le rapport committé porte 36
 * cas ignorés : ils s'affichaient tous comme des régressions. C'est le défaut
 * même que ce portail dénonce ailleurs — présenter « pas exécuté » comme « en
 * échec » —, et il le commettait sur sa page la plus regardée.
 *
 * `flaky` compte aussi : un cas qui passe au second essai n'est pas vert. Le
 * confondre avec un succès, c'est perdre le seul signal qui distingue un test
 * instable d'un test sûr.
 */
export function sortDuCas(essais) {
  const resultats = essais ?? [];
  if (resultats.length === 0) return 'ignoré';
  const statuts = resultats.map((r) => String(r.status ?? ''));
  if (statuts.every((s) => s === 'skipped')) return 'ignoré';
  const utiles = statuts.filter((s) => s !== 'skipped');
  if (utiles.every((s) => s === 'passed')) {
    // Passé du premier coup, ou passé après avoir échoué : ce n'est pas la
    // même chose, et seul le premier mérite le vert.
    return utiles.length > 1 ? 'instable' : 'vert';
  }
  if (utiles.some((s) => s === 'passed')) return 'instable';
  return 'rouge';
}

/** Le compte d'un fichier de parcours, par sort. */
export function compterParcours(cas) {
  const c = { total: 0, vert: 0, rouge: 0, ignoré: 0, instable: 0 };
  for (const sort of cas) {
    c.total += 1;
    c[sort] += 1;
  }
  return c;
}

// ─── Ce que la CI joue vraiment ───────────────────────────────────────────────

/**
 * Les parcours qu'un workflow exécute.
 *
 * Deux façons de les désigner, et il faut lire les deux :
 *   - NOMMÉS : `tests/e2e/smoke.spec.ts` écrit en toutes lettres (le job
 *     `e2e-smoke` de `ci.yml`) ;
 *   - BALAYÉS : un `ls tests/e2e/*.spec.ts` qui les prend tous, moins ceux
 *     qu'un `grep -v` retire (le job de mesure nocturne).
 *
 * Ne lire que les premiers laissait le portail annoncer « 2 parcours en CI »
 * pour toujours, même une fois la mesure nocturne en place — il aurait affirmé
 * que 28 parcours ne tournent jamais alors qu'ils tournaient chaque nuit
 * (revue Codex, PR #51).
 */
export function parcoursDunWorkflow(texte, tousLesParcours) {
  const nommes = [...texte.matchAll(/tests\/e2e\/([\w.-]+\.spec\.ts)/g)].map((m) => m[1]);

  // Un balayage : `ls tests/e2e/*.spec.ts`, avec ses exclusions éventuelles.
  const balaye = /ls\s+tests\/e2e\/\*\.spec\.ts/.test(texte);
  if (!balaye) return { nommes: [...new Set(nommes)], balaye: false, joues: [...new Set(nommes)] };

  const exclus = new Set(
    [...texte.matchAll(/grep\s+-v\s+'([\w.-]+\.spec\.ts)'/g)].map((m) => m[1]),
  );
  const joues = (tousLesParcours ?? []).filter((n) => !exclus.has(n));
  return { nommes: [...new Set(nommes)], balaye: true, exclus: [...exclus], joues };
}

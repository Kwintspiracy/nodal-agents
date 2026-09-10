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

// ─── Ce qui déclenche un workflow, et à quelle cadence ────────────────────────

/**
 * Les événements qui lancent un workflow, lus dans son texte.
 *
 * Vit ici, sous test, parce que la première version a passé une journée à
 * rendre une liste VIDE pour `ci.yml` sans que rien ne le signale : un `\b`
 * écrit depuis un script shell était devenu un caractère de contrôle littéral
 * (`\x08`) dans le fichier, et la regex cherchait un caractère invisible. Le
 * portail affichait « à la main » pour tous les parcours, y compris ceux joués
 * à chaque PR.
 *
 * Une détection muette qui se trompe est pire qu'une absente : elle répond.
 */
export function declencheursDunWorkflow(texte) {
  if (!/^on:/m.test(texte)) return [];
  const out = [];
  if (/^\s*push:/m.test(texte)) out.push('push');
  if (/^\s*pull_request:/m.test(texte)) out.push('pull_request');
  if (/^\s*schedule:/m.test(texte)) out.push('schedule');
  if (/workflow_dispatch/.test(texte)) out.push('manuel');
  return out;
}

/**
 * À quel rythme un workflow garde le dépôt.
 *
 * L'ordre n'est pas cosmétique : un parcours joué à chaque PR BLOQUE une
 * régression avant le merge ; joué chaque nuit, il la constate après. Les
 * confondre, c'est appeler « couvert » un parcours qui ne garde rien.
 */
export function cadenceDe(declencheurs) {
  const d = declencheurs ?? [];
  if (d.includes('pull_request')) return 'chaque PR';
  if (d.includes('schedule')) return 'chaque nuit';
  if (d.includes('push')) return 'chaque push sur main';
  return 'à la main';
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

// ─── Les capacités du produit ─────────────────────────────────────────────────
//
// Un test déclare ce qu'il prouve en écrivant `@cap:<slug>` dans son titre. La
// convention tient pour Vitest comme pour Playwright parce qu'aucun des deux
// n'a besoin de la comprendre : le titre voyage tel quel jusqu'au rapport.

/**
 * Les capacités qu'un titre revendique.
 *
 * Un titre peut en revendiquer plusieurs — un parcours de bout en bout traverse
 * souvent deux ou trois capacités, et prétendre le contraire forcerait à couper
 * des parcours utiles en morceaux pour satisfaire le registre.
 */
export function capacitesDunTitre(titre) {
  return [...String(titre ?? '').matchAll(/@cap:([a-z0-9-]+)/g)].map((m) => m[1]);
}

/**
 * Les titres des tests d'un fichier — `describe`, `it`, `test`, et leurs
 * variantes `.skip` / `.only` / `.each`.
 *
 * Le scan cherchait d'abord `@cap:` n'importe où dans le texte. Une mutation l'a
 * pris en flagrant délit : il lisait les étiquettes d'exemple qui vivent dans
 * les FIXTURES du portail lui-même, et signalait « @cap:tout-faire ne désigne
 * aucune capacité ». Le faux positif serait revenu à chaque fichier qui
 * documente la convention — et un contrôle qui crie à tort finit désactivé.
 *
 * Lire les titres est aussi plus fidèle à la règle : un test déclare ce qu'il
 * prouve DANS SON TITRE, pas dans un commentaire ni dans une chaîne de test.
 */
export function titresDeTest(texte) {
  const t = String(texte ?? '');
  const out = [];
  // Le `(?:\(…\)\s*)?` optionnel absorbe le PREMIER appel de `test.each([…])(…)`,
  // dont le titre n'arrive qu'au second. Sans lui, tout un fichier bâti sur
  // `.each` se déclarait sans le moindre test.
  const APPEL =
    /\b(?:describe|it|test)(?:\.\w+)*\s*(?:\([^()]*(?:\([^()]*\)[^()]*)*\)\s*)?\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  for (const m of t.matchAll(APPEL)) {
    out.push(m[2]);
  }
  return out;
}

/**
 * Ce qu'on peut dire d'une capacité, au vu des tests qui la revendiquent.
 *
 * Cinq états, et les deux derniers sont des trous DIFFÉRENTS qu'il ne faut
 * surtout pas confondre :
 *   - `jamais prouvée` : aucun test ne la revendique. Personne n'a écrit la
 *     preuve. C'est la colonne qui compte — la liste de ce qu'on croit livré ;
 *   - `non jouée` : un test la revendique, mais il n'a pas tourné (ignoré, ou
 *     jamais exécuté par aucune CI). La preuve existe et dort.
 *
 * Le rouge l'emporte sur tout le reste : une capacité tenue par trois tests
 * dont un échoue est cassée, pas « majoritairement verte ».
 */
export function etatDuneCapacite(preuves) {
  const p = preuves ?? [];
  if (p.length === 0) return 'jamais prouvée';
  const sorts = p.map((x) => x?.sort ?? null);
  if (sorts.some((s) => s === 'rouge')) return 'rouge';
  if (sorts.some((s) => s === 'instable')) return 'instable';
  if (sorts.some((s) => s === 'vert')) return 'prouvée';
  return 'non jouée';
}

/**
 * Ce que la porte refuse.
 *
 * Deux fautes, et deux seulement :
 *   1. une étiquette qui ne désigne aucune capacité du registre — une faute de
 *      frappe, ou un slug renommé. Sans ce contrôle l'étiquetage pourrit en
 *      trois semaines sans que personne ne le voie ;
 *   2. une capacité `exigee` que plus AUCUN test ne revendique — le cas du test
 *      supprimé ou renommé qui emporte la preuve avec lui.
 *
 * Ce qu'elle ne refuse PAS, et c'est délibéré : une capacité dont les tests
 * ÉCHOUENT. Cette porte garde le LIEN entre le produit et ses preuves ; la
 * gravité d'un rouge est le sujet de l'issue #65. Écrire ici qu'elle protège du
 * rouge en ferait une garde imaginaire, exactement ce que ce portail dénonce.
 */
export function fautesDuRegistre({ capacites, preuves } = {}) {
  const registre = capacites ?? [];
  const toutes = preuves ?? [];
  const slugs = new Set(registre.map((c) => c.slug));
  const fautes = [];

  const parEtiquette = new Map();
  for (const p of toutes) {
    const l = parEtiquette.get(p.capacite) ?? [];
    l.push(p.origine ?? '?');
    parEtiquette.set(p.capacite, l);
  }
  for (const [slug, origines] of parEtiquette) {
    if (slugs.has(slug)) continue;
    fautes.push({
      type: 'étiquette inconnue',
      slug,
      origines: [...new Set(origines)].sort(),
    });
  }

  for (const c of registre) {
    if (!c.exigee) continue;
    const siennes = toutes.filter((p) => p.capacite === c.slug);
    if (etatDuneCapacite(siennes) === 'jamais prouvée') {
      fautes.push({ type: 'capacité exigée sans preuve', slug: c.slug, nom: c.nom });
    }
  }

  return fautes;
}

/**
 * Les preuves d'une capacité, en croisant ce que le dépôt REVENDIQUE et ce que
 * la CI a JOUÉ.
 *
 * Deux sources qui ne disent pas la même chose :
 *   - `declarees` vient d'un scan des titres. Elle vaut pour tout le dépôt,
 *     tests unitaires compris, mais ne sait pas si le test passe ;
 *   - `e2e` vient d'un vrai rapport d'exécution. Elle sait, mais seulement pour
 *     les parcours qui ont tourné.
 *
 * Quand les deux parlent du même couple (fichier, capacité), l'exécution
 * l'emporte et la déclaration disparaît : la garder ferait compter deux fois la
 * même preuve, dont une sans résultat, et une capacité verte s'afficherait
 * éternellement « non jouée » à côté d'elle-même.
 */
export function croiserPreuves({ declarees, e2e } = {}) {
  const jouees = [];
  const remplaces = new Set();
  for (const p of e2e ?? []) {
    for (const c of p.resultat?.cas ?? []) {
      for (const slug of capacitesDunTitre(c.titreComplet ?? c.titre)) {
        // Un cas par preuve, jamais un fichier : quand une capacité tombe, la
        // seule information utile est QUEL test exact l'a lâchée.
        jouees.push({ capacite: slug, origine: p.fichier, titre: c.titre, sort: c.sort });
        remplaces.add(`${p.fichier}::${slug}`);
      }
    }
  }
  const restantes = (declarees ?? []).filter((d) => !remplaces.has(`${d.origine}::${d.capacite}`));
  return [...restantes, ...jouees];
}

/**
 * Le registre, chaque capacité munie de son état et des tests qui la tiennent.
 *
 * L'ordre du registre est conservé : il est groupé par domaine, et ce groupement
 * est la seule structure de l'écran. Trier par état mettrait les rouges en haut
 * mais ferait perdre « voici tout ce que le produit sait faire », qui est la
 * raison d'être de la page.
 */
export function regrouperParCapacite({ capacites, preuves } = {}) {
  const toutes = preuves ?? [];
  return (capacites ?? []).map((c) => {
    const siennes = toutes.filter((p) => p.capacite === c.slug);
    return { ...c, etat: etatDuneCapacite(siennes), preuves: siennes };
  });
}

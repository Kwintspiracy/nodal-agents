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
    if (carte.etat === 'MERGED') return 'Done';
    if (carte.etat === 'CLOSED') return 'Abandoned';
    return 'In review';
  }
  if (carte.etat !== 'OPEN') return 'Done';
  const etiquettes = carte.etiquettes ?? [];
  if (etiquettes.includes('decision')) return 'To do';
  if (etiquettes.includes('test')) return 'To test';
  // Une PR ouverte la ferme (`parPr`, posé par `cartesDuTableau`) : le travail
  // est écrit, il attend sa relecture — pas « en cours » (12/09).
  if (carte.parPr != null) return 'In review';
  return 'In progress';
}

export const COLONNES = ['To do', 'In progress', 'In review', 'To test', 'Done'];

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

/**
 * Ce qu'il faut dire d'un parcours AVANT de regarder son dernier rapport.
 *
 * Trois états, et le premier est le seul qui soit une faute du dépôt :
 *
 *  - `jamais joué` — le fichier existe, aucune intégration continue ne le
 *    lance. C'est un ROUGE, et il porte son nom. Le portail l'affichait
 *    « never run here » en gris neutre, la même couleur qu'un parcours sain
 *    dont le rapport manque : `agent-flows.spec.ts` a passé un an ainsi, à
 *    réclamer un LM Studio que personne ne lançait (issue #110). Un gris ne
 *    demande rien à personne.
 *  - `sans rapport` — la CI le joue, ce rendu-ci n'a simplement pas son
 *    rapport Playwright (un rendu local n'en a jamais). Inconnu, pas rouge :
 *    peindre trente lignes en rouge sur une machine de développeur ferait une
 *    page qui ne veut plus rien dire.
 *  - `joué` — le rapport parle, et c'est lui qui décide de la couleur.
 *
 * Un rapport local ne rachète PAS un parcours qu'aucune CI ne joue : le fait
 * mesuré est « gardé par une intégration continue », pas « lancé une fois ».
 */
export function etatDunParcours(p) {
  // Un workflow dont on n'a pas su lire la forme ne prouve RIEN, ni dans un
  // sens ni dans l'autre. Le dire « jamais joué » serait une affirmation qu'on
  // ne peut pas faire — et elle peindrait trente lignes en rouge sur une panne
  // de lecture du portail, pas du dépôt.
  if (!p?.jouParLaCi && p?.ciIllisible) {
    return { cle: 'ci illisible', rouge: false, mot: 'workflow unreadable' };
  }
  if (!p?.jouParLaCi) return { cle: 'jamais joué', rouge: true, mot: 'never played' };
  if (!p.resultat) return { cle: 'sans rapport', rouge: false, mot: 'never run here' };
  return { cle: 'joué', rouge: false, mot: null };
}

/**
 * Sous quel titre un parcours se range sur la page Journeys.
 *
 * Sa cadence quand une CI le joue ; sinon le MOT d'`etatDunParcours`, et non un
 * libellé recalculé. La page en avait un à elle (`p.cadence ?? (p.ciIllisible ?
 * … : …)`) : deux définitions d'une même chose, donc un bac et une couleur de
 * ligne qui se contrediront le jour où un quatrième état apparaîtra, sans que
 * rien ne le dise (revue de la PR #113, 2e passe).
 */
export function cadenceAffichee(p) {
  return p?.cadence ?? etatDunParcours(p).mot;
}

/**
 * Les bacs de la page Journeys, du plus protecteur au moins protecteur.
 *
 * Tout ce que `cadenceAffichee` peut rendre DOIT figurer ici : un libellé
 * absent de cette liste ferait disparaître ses parcours de la page en silence.
 */
export const ORDRE_DES_BACS = [
  'every pull request',
  'every push to main',
  'every night',
  'by hand',
  'never played',
  'workflow unreadable',
];

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
 * Le texte d'un workflow SANS ses commentaires.
 *
 * Tout ce que ce fichier lit d'un workflow — ses déclencheurs, les parcours
 * qu'il joue — se lisait dans le texte entier, commentaires compris. Or nos
 * workflows sont abondamment commentés, et ces commentaires nomment les choses
 * dont ils parlent : `qa.yml` explique en toutes lettres pourquoi
 * `agent-flows.spec.ts` était exclu, `docs.yml` pourquoi il prend
 * `pull_request_target` « et non `pull_request` ». Une phrase d'explication
 * suffisait donc à déclarer un parcours joué, ou à inventer un déclencheur.
 *
 * Un commentaire YAML commence à un `#` en début de ligne ou précédé d'une
 * espace, hors chaîne — `- cron: '17 3 * * *'` et `echo "a # b"` n'en portent
 * aucun. Les lignes sont GARDÉES (tronquées, jamais supprimées) : les regex
 * ancrées sur `^` qui lisent ce texte comptent sur la structure des lignes.
 */
export function sansCommentairesYaml(texte) {
  return String(texte ?? '')
    .split('\n')
    .map((ligne) => {
      let guillemet = null;
      for (let i = 0; i < ligne.length; i += 1) {
        const c = ligne[i];
        if (guillemet) {
          if (c === guillemet) guillemet = null;
          continue;
        }
        if (c === "'" || c === '"') {
          guillemet = c;
          continue;
        }
        if (c === '#' && (i === 0 || /\s/.test(ligne[i - 1]))) return ligne.slice(0, i);
      }
      return ligne;
    })
    .join('\n');
}

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
export function declencheursDunWorkflow(texte0) {
  const texte = sansCommentairesYaml(texte0);
  if (!/^on:/m.test(texte)) return [];
  const out = [];
  if (/^\s*push:/m.test(texte)) out.push('push');
  if (/^\s*pull_request:/m.test(texte)) out.push('pull_request');
  if (/^\s*schedule:/m.test(texte)) out.push('schedule');
  if (/workflow_dispatch/.test(texte)) out.push('manual');
  return out;
}

/**
 * À quel rythme un workflow garde le dépôt.
 *
 * L'ordre n'est pas cosmétique : un parcours joué à chaque PR BLOQUE une
 * régression avant le merge ; joué chaque nuit, il la constate après. Les
 * confondre, c'est appeler « couvert » un parcours qui ne garde rien.
 */
/** La cadence qui BLOQUE — la plus forte des quatre. */
export const CADENCE_CHAQUE_PR = 'every pull request';
/** La cadence qui ne garde rien : personne ne la déclenche tout seul. */
export const CADENCE_A_LA_MAIN = 'by hand';

export function cadenceDe(declencheurs) {
  const d = declencheurs ?? [];
  if (d.includes('pull_request')) return CADENCE_CHAQUE_PR;
  if (d.includes('schedule')) return 'every night';
  if (d.includes('push')) return 'every push to main';
  return CADENCE_A_LA_MAIN;
}

// ─── Ce qu'une PR coûte en contrôles ──────────────────────────────────────────
//
// La question de Quentin, et elle est la bonne : combien de minutes chaque PR
// coûte en contrôles, et est-ce que ça dérive. C'est ce chiffre-là qui décide
// du sort des tests — le jour où attendre son merge devient insupportable,
// personne ne demande la permission avant de désactiver une suite.
//
// Le chiffre n'est donc pas une curiosité de performance : c'est l'indicateur
// AVANCÉ de la prochaine porte qu'on va retirer.

/** La médiane d'une liste DÉJÀ TRIÉE. `null` sur une liste vide — jamais zéro. */
export function medianeDe(triee) {
  const l = triee ?? [];
  if (l.length === 0) return null;
  const mi = Math.floor(l.length / 2);
  return l.length % 2 === 1 ? l[mi] : Number(((l[mi - 1] + l[mi]) / 2).toFixed(2));
}

/** Au-delà de ce pourcentage entre les deux moitiés de la fenêtre, la durée BOUGE. */
const SEUIL_TENDANCE_PRIX = 15;

/**
 * Ce qu'une PR coûte, lu dans les exécutions passées de la CI.
 *
 * Durée = `updatedAt` − `createdAt`, c'est-à-dire la durée MUR À MUR du run,
 * file d'attente comprise, et non la somme des durées de ses jobs. C'est un
 * choix : la somme des jobs mesure ce que la CI consomme, la durée mur à mur
 * mesure ce que quelqu'un ATTEND devant sa PR. Le second est le seul qui
 * explique pourquoi on finit par désactiver des tests.
 *
 * Seuls les runs VERTS comptent. Un run rouge s'arrête au premier job qui
 * tombe — souvent en trois minutes — et le compter ferait baisser la médiane
 * chaque fois que la CI va mal, c'est-à-dire exactement quand on veut la
 * regarder.
 *
 * `null` quand GitHub n'a pas répondu : une absence n'est pas un coût de zéro.
 */
export function prixDeLaCi(runs) {
  if (!Array.isArray(runs)) return null;

  const verts = runs
    .filter((r) => String(r?.conclusion ?? '').toLowerCase() === 'success')
    .map((r) => {
      const de = Date.parse(r?.createdAt);
      const a = Date.parse(r?.updatedAt);
      if (!Number.isFinite(de) || !Number.isFinite(a) || a < de) return null;
      return { le: r.createdAt, valeur: Number(((a - de) / 60000).toFixed(1)), url: r.url ?? null };
    })
    .filter(Boolean)
    // Du plus ancien au plus récent : c'est l'ordre d'une courbe, et l'ordre
    // dans lequel se lit une dérive. `gh` rend l'inverse.
    .sort((x, y) => Date.parse(x.le) - Date.parse(y.le));

  const vide = {
    runs: 0,
    serie: [],
    mediane: null,
    medianeRecente: null,
    dernier: null,
    pire: null,
    hausse: null,
    deltaMin: null,
    tendance: null,
  };
  if (verts.length === 0) return vide;

  const vals = verts.map((v) => v.valeur);
  const tri = [...vals].sort((a, b) => a - b);
  // Les DIX derniers, et pas toute la fenêtre, pour l'alerte : trente runs
  // remontent à plusieurs semaines, et une CI qui vient de doubler resterait
  // masquée par vingt mesures d'avant.
  const dixDerniers = [...vals.slice(-10)].sort((a, b) => a - b);

  // Première moitié contre seconde moitié, médiane contre médiane. Le point du
  // milieu est écarté sur un nombre impair : il appartiendrait aux deux.
  let hausse = null;
  let deltaMin = null;
  if (vals.length >= 2) {
    const avant = medianeDe([...vals.slice(0, Math.floor(vals.length / 2))].sort((a, b) => a - b));
    const apres = medianeDe([...vals.slice(Math.ceil(vals.length / 2))].sort((a, b) => a - b));
    deltaMin = Number((apres - avant).toFixed(1));
    if (avant > 0) hausse = Number((((apres - avant) / avant) * 100).toFixed(1));
  }

  return {
    runs: verts.length,
    serie: verts.map(({ le, valeur }) => ({ le, valeur })),
    mediane: medianeDe(tri),
    medianeRecente: medianeDe(dixDerniers),
    dernier: verts.at(-1).valeur,
    pire: Math.max(...vals),
    hausse,
    // Le même écart en minutes : un pourcentage ne dit pas si on parle de
    // trente secondes ou d'un quart d'heure.
    deltaMin,
    // Sur un seul run vert, pas de tendance. « Stable » serait une affirmation
    // qu'on ne peut pas faire — la même règle que `tendance()`.
    tendance:
      hausse == null
        ? null
        : hausse > SEUIL_TENDANCE_PRIX
          ? 'monte'
          : hausse < -SEUIL_TENDANCE_PRIX
            ? 'descend'
            : 'stable',
  };
}

// ─── Ce que la CI joue vraiment ───────────────────────────────────────────────

/** Le balayage, et TOUT ce qui le suit sur sa ligne — c'est là que les filtres vivent. */
const BALAYAGE = /ls\s+tests\/e2e\/\*\.spec\.ts([^\n]*)/;

/**
 * Un segment de tuyau qui retire un parcours : `grep -v` et son motif, dans
 * les trois façons de l'écrire en shell.
 */
const EXCLUSION =
  /^grep\s+-v\s+(?:'([\w.-]+\.spec\.ts)'|"([\w.-]+\.spec\.ts)"|([\w.-]+\.spec\.ts))$/;

/**
 * Ce que le tuyau qui suit le balayage retire — ou l'aveu qu'on ne sait pas.
 *
 * La première version ne connaissait QUE `grep -v 'x.spec.ts'` à simples
 * quotes. Réintroduire une exclusion sous n'importe quelle autre forme
 * (`"x.spec.ts"`, sans quotes, `grep -vE`, `grep -v -e`, `head`, `sed`…) la
 * rendait invisible : le parcours exclu restait dans `joues`, donc VERT et
 * absent de l'alerte, et aucun drapeau ne se levait puisque le `ls` était bien
 * reconnu. C'est le faux-vert que ce lot existe pour tuer, à l'endroit même où
 * il le tue (revue de la PR #113, 2e passe).
 *
 * Trois formes se lisent. Tout le reste rend `illisible` : un tuyau qu'on ne
 * comprend pas ne vaut pas mieux qu'un tuyau absent, et « workflow unreadable »
 * est une réponse honnête là où « tout est joué » est une invention.
 */
export function exclusionsDuBalayage(suite) {
  // La queue de la substitution de processus — `…)` de `< <(ls … )` — n'est pas
  // un segment de tuyau. Les quotes, elles, sont GARDÉES : les retirer casserait
  // la forme à guillemets doubles, qui est justement une de celles à lire.
  const tuyau = String(suite ?? '').replace(/[\s)]*$/, '');
  if (tuyau.trim() === '') return { exclus: [], illisible: false };

  const exclus = [];
  for (const segment of tuyau.split('|').map((s) => s.trim())) {
    if (segment === '') continue;
    const m = EXCLUSION.exec(segment);
    if (!m) return { exclus: [], illisible: true };
    exclus.push(m[1] ?? m[2] ?? m[3]);
  }
  return { exclus, illisible: false };
}

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
export function parcoursDunWorkflow(texte0, tousLesParcours) {
  // Les commentaires ne jouent rien. Ils EXPLIQUENT, souvent en nommant le
  // parcours dont ils parlent — `qa.yml` raconte sur six lignes pourquoi
  // `agent-flows.spec.ts` était exclu. Les lire, c'était laisser une phrase
  // d'explication tenir lieu d'exécution.
  const texte = sansCommentairesYaml(texte0);
  const nommes = [...texte.matchAll(/tests\/e2e\/([\w.-]+\.spec\.ts)/g)].map((m) => m[1]);

  // Un balayage : `ls tests/e2e/*.spec.ts`, avec ses exclusions éventuelles.
  const balayage = BALAYAGE.exec(texte);
  const balaye = balayage !== null;
  if (!balaye) {
    // Le workflow parle du dossier des parcours, et pourtant on n'en a tiré
    // NI un nom NI un balayage : sa forme a changé sous nos pieds (un
    // `playwright test tests/e2e` suffit). Rendre « aucun parcours joué »
    // serait répondre à une question qu'on n'a pas comprise — et le portail
    // afficherait trente parcours morts sur une panne de LECTURE. On le dit.
    const illisible = nommes.length === 0 && /tests\/e2e/.test(texte);
    const uniques = [...new Set(nommes)];
    return { nommes: uniques, balaye: false, exclus: [], joues: uniques, illisible };
  }

  const filtre = exclusionsDuBalayage(balayage[1] ?? '');
  if (filtre.illisible) {
    // Le `ls` est là ; la SUITE du tuyau ne se lit pas. Répondre « tout est
    // joué » inventerait un vert sur un filtre qu'on n'a pas compris — le
    // faux-vert que ce lot existe pour tuer. On ne sait pas, et on le dit.
    return { nommes: [...new Set(nommes)], balaye: true, exclus: [], joues: [], illisible: true };
  }
  const exclus = new Set(filtre.exclus);
  const joues = (tousLesParcours ?? []).filter((n) => !exclus.has(n));
  return {
    nommes: [...new Set(nommes)],
    balaye: true,
    exclus: [...exclus],
    joues,
    illisible: false,
  };
}

/**
 * Quel workflow joue quel parcours, et à quelle cadence — la SEULE définition.
 *
 * Deux choses s'y décident, et elles se lisaient nulle part :
 *
 *  - Un workflow qu'il faut lancer À LA MAIN ne garde rien. Le compter,
 *    c'était laisser un `workflow_dispatch` que personne ne déclenche rendre
 *    un parcours « joué », donc non rouge : exactement le gris que ce lot
 *    remplace par un rouge nommé (issue #110).
 *  - « chaque PR » est la cadence la plus forte : elle l'emporte sur une
 *    mesure nocturne qui joue le même fichier.
 */
export function cadenceParParcours(workflows) {
  const parNom = new Map();
  for (const w of workflows ?? []) {
    if (!w?.cadence || w.cadence === CADENCE_A_LA_MAIN) continue;
    for (const nom of w.specsNommees ?? []) {
      if (parNom.get(nom) === CADENCE_CHAQUE_PR) continue;
      parNom.set(nom, w.cadence);
    }
  }
  return parNom;
}

/**
 * Une famille de chantiers (issues ou PR), demandée en DEUX requêtes — les
 * ouverts en entier, les fermés récents — et recollée sans doublon.
 *
 * Une seule requête `--state all` bornée évinçait un chantier ouvert ancien
 * derrière cinquante fermés récents (revue Codex, 3e passe). Deux requêtes, et
 * un chantier fermé ENTRE les deux apparaît dans les deux réponses : sans
 * dédoublonnage il faisait deux cartes, « En cours » et « Fait » (4e passe).
 * Le fermé l'emporte — c'est l'état le plus récent.
 *
 * `null` dès qu'une des deux n'a pas abouti, pour la même raison que
 * `cartesDuTableau` : une absence n'est pas un zéro.
 */
export function fusionnerEtats(ouverts, fermes) {
  if (!ouverts || !fermes) return null;
  const parNumero = new Map();
  for (const x of ouverts) parNumero.set(x.number, x);
  for (const x of fermes) parNumero.set(x.number, x);
  return [...parNumero.values()];
}

/**
 * Les cartes du tableau, à partir de ce que GitHub a répondu.
 *
 * Rend `null` — et non une liste vide — dès qu'une des deux requêtes n'a PAS
 * abouti. La distinction est tout l'objet de cette fonction : « personne n'a
 * rien ouvert » et « je n'ai pas pu demander » se ressemblent à l'écran et ne
 * veulent pas dire la même chose.
 *
 * Le collecteur écrivait `?? []`. Dans la mesure nocturne, où `gh` tourne sans
 * jeton, les deux requêtes échouent : le portail publiait chaque nuit un Kanban
 * VIDE par-dessus le vrai, sans un mot. C'est exactement le défaut qu'il dénonce
 * partout ailleurs — rendre une absence comme un zéro — commis chez lui.
 */
export function cartesDuTableau({ issues, pr } = {}) {
  if (!Array.isArray(issues) || !Array.isArray(pr)) return null;

  // Les issues qu'une PR OUVERTE ferme (« Closes #n », « Fixes #n »,
  // « Resolves #n » dans son corps — le vocabulaire que GitHub lie). Une telle
  // issue n'est plus « en cours » : son travail est écrit et attend sa
  // relecture. Une PR mergée ou fermée ne couvre plus rien — GitHub aura fermé
  // l'issue, ou elle est retombée à ce qu'elle est.
  const couvertes = new Map();
  for (const p of pr) {
    if (p.state !== 'OPEN' || p.mergedAt) continue;
    for (const m of String(p.body ?? '').matchAll(
      /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi,
    )) {
      if (!couvertes.has(Number(m[1]))) couvertes.set(Number(m[1]), p.number);
    }
  }

  // La provenance, lue UNE fois ici. Le corps d'une issue pèse plusieurs
  // kilo-octets et n'a rien à faire dans le snapshot : seuls les deux verdicts
  // qu'on en tire voyagent.
  const provenance = (corps) => ({
    parUnAgent: ecritParUnAgent(corps),
    faitsVerifies: porteDesFaitsVerifies(corps),
  });

  // L'état de la revue, lu UNE fois par PR (#128). Comme la provenance : les
  // commentaires pèsent lourd et ne vont pas dans le snapshot, seul l'état
  // qu'on en tire voyage. Les issues qu'une PR ouverte ferme héritent du même
  // objet, pour que les trois cartes d'un même travail disent la même chose.
  const revueDunePr = new Map();
  for (const p of pr) {
    const commentaires = p.comments ?? [];
    const etat = reviewState([p.body, ...commentaires.map((c) => c?.body)]);
    // Une liste de commentaires qui atteint le plafond d'une page peut être
    // TRONQUÉE, et une passe plus récente serait alors invisible : la carte
    // retomberait en « not reviewed yet » sans que rien ne le dise. Le cas
    // n'est pas démontré sur ce dépôt — la plus longue liste y fait sept
    // commentaires — et `gh` ne promet rien sur ce point ; il est donc DIT et
    // non supposé résolu (revue C de la PR #175).
    if (commentaires.length >= COMMENTAIRES_PAR_PAGE) {
      etat.warnings = [
        ...etat.warnings,
        `comment list of PR #${p.number} reached ${COMMENTAIRES_PAR_PAGE}: a later review pass may be missing`,
      ];
    }
    revueDunePr.set(p.number, etat);
  }

  const cartes = [
    ...issues.map((i) => ({
      type: 'issue',
      numero: i.number,
      titre: i.title,
      etat: i.state,
      url: i.url,
      etiquettes: (i.labels ?? []).map((l) => l.name),
      majLe: i.updatedAt ?? null,
      creeLe: i.createdAt ?? null,
      // Quand cette carte a été FINIE — `null` tant qu'elle ne l'est pas, et
      // `null` aussi quand GitHub ne l'a pas dit. Jamais remplacée par la date
      // de mise à jour : une carte rouverte puis commentée serait datée d'un
      // jour où rien ne s'est fini (#176).
      finiLe: i.closedAt ?? null,
      release: titreDeJalon(i.milestone),
      parPr: couvertes.get(i.number) ?? null,
      // L'état de la revue de LA PR qui la ferme, quand il y en a une : les
      // trois cartes d'un même travail se lisaient « In review » sans jamais
      // dire où en était cette revue (#128).
      revue: couvertes.has(i.number) ? (revueDunePr.get(couvertes.get(i.number)) ?? null) : null,
      ...provenance(i.body),
    })),
    ...pr.map((p) => ({
      type: 'pr',
      numero: p.number,
      titre: p.title,
      etat: p.mergedAt ? 'MERGED' : p.state,
      url: p.url,
      brouillon: p.isDraft ?? false,
      etiquettes: [],
      majLe: p.updatedAt ?? null,
      creeLe: p.createdAt ?? null,
      // Le merge d'abord : une PR mergée est fermée dans la foulée, et les deux
      // dates sont à la seconde près. C'est le merge qui a fini le travail.
      finiLe: p.mergedAt ?? p.closedAt ?? null,
      release: titreDeJalon(p.milestone),
      ci: etatCi(p.statusCheckRollup),
      revue: revueDunePr.get(p.number) ?? null,
      ...provenance(p.body),
    })),
  ];

  return cartes.map((c) => ({ ...c, colonne: colonneDeCarte(c) }));
}

// ─── À quelle release une carte appartient ────────────────────────────────────
//
// Le jalon GitHub le dit déjà — les PR de la 0.8.10 le portent —, et le tableau
// ne le rendait nulle part (#177). « Qu'est-ce qui constitue la 0.8.10 » ne se
// lisait donc que sur GitHub, une carte à la fois.
//
// Le titre du jalon, et rien d'autre : ni sa description, ni sa date. Une carte
// sans jalon dit « no release » — c'est un fait, et un travail non rattaché
// mérite d'être vu comme tel, pas d'être rendu invisible.

/** Ce que le tableau retient d'un jalon : son titre, ou `null`. */
export function titreDeJalon(jalon) {
  const titre = typeof jalon?.title === 'string' ? jalon.title.trim() : '';
  return titre === '' ? null : titre;
}

/** Ce que porte une carte sans jalon — dit, jamais laissé en blanc. */
export const SANS_RELEASE = 'no release';

/**
 * La release demandée par une adresse : `#chantiers?release=0.9` → `0.9`.
 *
 * Le filtre vit dans l'ADRESSE (revue C de la PR #192) : sans cela, « ce qui
 * constitue la 0.9 » ne se partageait pas — le lien renvoyait au tableau
 * entier, et le destinataire devait deviner quel bouton cliquer. Rien, une
 * adresse sans requête ou une valeur illisible rendent `''`, c'est-à-dire tout
 * le tableau : une adresse abîmée montre trop, jamais rien.
 *
 * Écrite pour être lue DEUX fois : ici par les tests, et par la page, où
 * `build.mjs` l'inscrit telle quelle. Elle ne ferme donc sur rien et n'emploie
 * que ce qu'un navigateur connaît depuis toujours.
 */
export function releaseDuHash(hash) {
  var brut = String(hash == null ? '' : hash);
  var i = brut.indexOf('?');
  if (i < 0) return '';
  var m = /(?:^|&)release=([^&]*)/.exec(brut.slice(i + 1));
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]);
  } catch (e) {
    return '';
  }
}

/** L'adresse qui montre une release : `0.9` → `#chantiers?release=0.9`. */
export function hashDeLaRelease(release) {
  var r = String(release == null ? '' : release);
  return r === '' ? '#chantiers' : '#chantiers?release=' + encodeURIComponent(r);
}

/**
 * Le titre d'un jalon ramené à une forme que `comparerSemver` sait lire, ou
 * `null` si ce n'en est pas une.
 *
 * Deux segments comptent : ce dépôt nomme ses jalons « 0.9 » autant que
 * « 0.8.10 » (vu en collectant le 18/09/2026 — 28 cartes sous « 0.9 »). Sans
 * cette lecture, « 0.9 » n'était pas une version du tout et se rangeait
 * APRÈS « 0.8.10 », dans les jalons alphabétiques : le filtre s'ouvrait sur la
 * release passée en donnant la suivante pour un nom quelconque.
 */
function comparable(titre) {
  const t = String(titre ?? '').trim();
  if (/^v?\d+\.\d+$/.test(t)) return `${t}.0`;
  return comparerSemver(t, t) === null ? null : t;
}

/**
 * Les releases présentes sur le tableau, pour en faire un filtre.
 *
 * Rangées de la plus récente à la plus ancienne par `comparerSemver`, qui sait
 * déjà que `0.8.10` vient après `0.8.9` — un tri de chaînes mettrait la 0.8.10
 * avant la 0.8.9 et le filtre s'ouvrirait sur la mauvaise. Ce qui n'est pas un
 * numéro de version garde son ordre alphabétique, après les numéros : un jalon
 * nommé « Backlog » n'est pas une version et ne prétend pas l'être.
 * « no release » ferme la marche quand au moins une carte n'a pas de jalon.
 */
export function releasesDuTableau(cartes) {
  const titres = [
    ...new Set(
      (cartes ?? []).map((c) => c.release).filter((r) => typeof r === 'string' && r !== ''),
    ),
  ];
  const versions = titres.filter((t) => comparable(t) !== null);
  const autres = titres.filter((t) => comparable(t) === null).sort();
  versions.sort((a, b) => -(comparerSemver(comparable(a), comparable(b)) ?? 0));
  const sansJalon = (cartes ?? []).some((c) => !c.release);
  return [...versions, ...autres, ...(sansJalon ? [SANS_RELEASE] : [])];
}

// ─── Ce qu'une colonne MONTRE ─────────────────────────────────────────────────
//
// « Done » gardait ses huit premières cartes dans l'ordre où elles arrivaient,
// c'est-à-dire par numéro décroissant : l'ordre d'OUVERTURE, pas celui
// d'achèvement. Le 16/09/2026, les huit issues fermées de la journée ont donc
// rempli les huit places, et les six PR mergées le même jour sont parties dans
// « + 67 more » : le tableau a montré 75 cartes finies et pas une seule des PR
// qui les avaient finies (#176).
//
// La colonne répond maintenant à la question qu'on lui pose vraiment — « qu'a-
// t-on fini ces jours-ci ? » — donc une FENÊTRE de temps, du plus récent au
// plus ancien, et le reste replié sous son compte.

/** La fenêtre de « Done » : ce qui s'est fini dans la semaine. */
export const JOURS_DE_FENETRE = 7;

/**
 * Le minimum qu'une colonne finie montre quand la fenêtre est vide.
 *
 * Une semaine sans rien finir est un fait, et la colonne le dit en ne montrant
 * presque rien. Mais la vider complètement sous un « + 75 older » cacherait
 * jusqu'au dernier travail livré, que le plafond de huit montrait au moins.
 * Trois cartes : assez pour savoir où on en était, trop peu pour faire croire
 * que c'est de cette semaine.
 */
const MINIMUM_VISIBLE = 3;

/** Les colonnes qui regardent en arrière, et se lisent donc par date. */
const COLONNES_FINIES = new Set(['Done', 'Abandoned']);

/** Une date lisible en millisecondes, ou `null` — jamais une date inventée. */
function instant(valeur) {
  const t = Date.parse(String(valeur ?? ''));
  return Number.isFinite(t) ? t : null;
}

/**
 * Ce qu'une colonne montre, et ce qu'elle replie.
 *
 * Les colonnes vivantes (« To do » à « In review ») montrent tout : ce sont des
 * appels à l'action, et en cacher un le ferait oublier.
 *
 * Les colonnes finies se rangent du plus récemment fini au plus ancien, PR
 * mergées et issues fermées MÊLÉES. Pas de bande « merged » à part : la
 * question est chronologique, la carte d'une PR se reconnaît déjà à son liseré
 * et à son « PR #n », et couper la colonne en deux rendrait la même question
 * qu'aujourd'hui — laquelle des deux piles faut-il lire d'abord.
 *
 * Une carte SANS date de fin ne peut pas entrer dans une fenêtre : elle est
 * repliée avec les anciennes, jamais datée d'office.
 */
export function pileDuneColonne(cartes, nom, maintenant = Date.now(), jours = JOURS_DE_FENETRE) {
  const dedans = (cartes ?? []).filter((c) => c.colonne === nom);
  if (!COLONNES_FINIES.has(nom)) {
    return { montrees: dedans, replies: 0, plusAnciennes: 0, sansDate: 0 };
  }

  const datees = dedans
    .map((c) => ({ carte: c, quand: instant(c.finiLe) }))
    .sort((a, b) => (b.quand ?? -Infinity) - (a.quand ?? -Infinity));
  const depuis = maintenant - jours * 24 * 60 * 60 * 1000;
  const dansLaFenetre = datees.filter((d) => d.quand !== null && d.quand >= depuis);
  const montrees =
    dansLaFenetre.length > 0
      ? dansLaFenetre
      : datees.slice(0, MINIMUM_VISIBLE).filter((d) => d.quand !== null);

  // Le repli se compte en DEUX, parce que ce sont deux choses (revue C de la
  // PR #188) : ce qui est plus ancien que la fenêtre, et ce dont on ignore la
  // date. Les mettre ensemble sous « older » affirmerait d'une carte sans date
  // qu'elle est vieille, et c'est justement ce qu'on ne sait pas.
  const sansDate = dedans.filter((c) => instant(c.finiLe) === null).length;
  const replies = dedans.length - montrees.length;
  return {
    montrees: montrees.map((d) => d.carte),
    replies,
    plusAnciennes: replies - sansDate,
    sansDate,
  };
}

// ─── Ce que le dépôt sait de sa propre release ────────────────────────────────
//
// Le 12/09/2026, un agent a ouvert « Publish 0.8.9 » de mémoire : 0.8.9 était
// sur npm depuis trois jours. Le portail a porté ce travail fantôme quatre
// jours, parce qu'il n'avait aucun moyen de le contredire. Il en a un
// maintenant, et il ne dépend de la bonne volonté de personne : il DEMANDE à
// npm et à git.

/**
 * Compare deux identifiants de préversion, segment par segment, selon
 * semver 2.0 §11 : on découpe sur `.`, deux segments numériques se comparent
 * en NOMBRES, un numérique passe avant un alphanumérique, et un identifiant
 * plus court qui préfixe l'autre vient avant (`rc` < `rc.1`).
 *
 * Comparer les identifiants comme des chaînes rendait `rc.10 < rc.2` : une
 * carte « Publish 1.0.0-rc.10 » face à un npm en `rc.2` était accusée en
 * gravité haute de demander une version déjà publiée, alors qu'elle était la
 * plus récente. C'est la même faute que `0.8.10 < 0.8.9`, un cran plus loin.
 */
function comparerPrerelease(a, b) {
  const xs = a.split('.');
  const ys = b.split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i += 1) {
    const u = xs[i];
    const v = ys[i];
    if (u === undefined) return -1;
    if (v === undefined) return 1;
    const uNum = /^\d+$/.test(u);
    const vNum = /^\d+$/.test(v);
    if (uNum && vNum) {
      const d = Number(u) - Number(v);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (uNum !== vNum) {
      return uNum ? -1 : 1;
    } else if (u !== v) {
      return u < v ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Compare deux numéros de version. `-1`, `0`, `1`, et `null` sur ce qui n'est
 * pas un semver — plutôt qu'un ordre inventé qui accuserait au hasard.
 *
 * Une comparaison de chaînes rendrait `0.8.10 < 0.8.9`, c'est-à-dire
 * exactement l'erreur que ce lot existe pour empêcher.
 */
export function comparerSemver(a, b) {
  const lire = (v) => /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(String(v ?? '').trim());
  const x = lire(a);
  const y = lire(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i += 1) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  // `0.9.0-rc.1` vient AVANT `0.9.0` : une préversion n'est pas la version.
  if ((x[4] ?? '') === (y[4] ?? '')) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  return comparerPrerelease(x[4], y[4]);
}

/**
 * Ce que `npm view <paquet> version time --json` a VRAIMENT répondu.
 *
 * Trois faits, pas deux. Un paquet JAMAIS PUBLIÉ fait répondre npm par une
 * erreur `E404` — le registre a parlé, et il a dit « ce nom n'existe pas ».
 * L'afficher en « npm unreachable » accusait le réseau d'un fait que npm venait
 * d'établir, et laissait croire qu'on ne savait pas.
 *
 * `sortie` est le stdout, `erreur` le stderr (ou le message de l'échec).
 * Avec `--json`, npm range son erreur dans le stdout lui-même, d'où les deux
 * endroits regardés.
 *
 * Seul le CODE de npm compte, pas un « 404 » croisé n'importe où : un proxy
 * d'entreprise qui répond 404 pour une tout autre raison écrit lui aussi ce
 * nombre dans stderr, et le prendre pour un verdict du registre transformerait
 * une panne d'accès en « ce paquet n'existe pas ». C'est le même défaut à
 * l'envers. Sortie réelle de `npm view paquet-inexistant --json` (npm 11) :
 *
 *     npm error code E404
 *     npm error 404 Not Found - GET https://registry.npmjs.org/… - Not found
 *
 * et sur les npm plus anciens, `npm ERR! code E404`. La ligne reconnue est donc
 * celle du CODE, et elle seule.
 */
export function lectureDeNpm({ sortie, erreur } = {}) {
  let lu = null;
  try {
    lu = JSON.parse(String(sortie ?? ''));
  } catch {
    lu = null;
  }
  const dansLeJson = lu?.error?.code === 'E404';
  const dansStderr = /npm\s+(?:error|ERR!)\s+code\s+E404\b/i.test(String(erreur ?? ''));
  if (dansLeJson || dansStderr) return { etat: 'jamais-publiee', npm: null };
  // `version` est la chaîne attendue ; tout le reste est une réponse qu'on ne
  // sait pas lire, donc une absence, jamais une valeur approchée.
  if (typeof lu?.version === 'string') {
    return { etat: 'lue', npm: { version: lu.version, time: lu.time ?? null } };
  }
  return { etat: 'injoignable', npm: null };
}

/**
 * Le nombre de commits depuis le dernier tag, à partir des sorties de git.
 *
 * `origin/main` d'abord : le nombre qui intéresse est celui de la branche
 * PUBLIÉE, pas de la branche de travail d'où la collecte est lancée. Une
 * référence absente (checkout superficiel de la CI) retombe sur `HEAD`, parce
 * que git sait répondre là — ce n'est pas un repli inventé, c'est une seconde
 * question posée.
 *
 * Une sortie qui n'est pas un entier rend `null` et non `0` : `Number('')` vaut
 * zéro, et « aucun commit depuis le tag » est une affirmation, pas une absence.
 */
export function commitsDepuisLeTag({ surLaBranchePubliee, surHead } = {}) {
  for (const sortie of [surLaBranchePubliee, surHead]) {
    const t = String(sortie ?? '').trim();
    if (/^\d+$/.test(t)) return Number(t);
  }
  return null;
}

/**
 * L'état de la release : ce que npm sert, ce que le dépôt porte, et l'écart.
 *
 * `npm` est la réponse de `npm view … --json`, ou `null` quand le registre n'a
 * pas répondu. Dans ce cas RIEN n'est rendu : pas de valeur inventée, pas
 * l'ancienne sans date. Le portail dira « npm unreachable at <heure> », ce qui
 * est un fait, là où un chiffre périmé serait un mensonge (invariant #4).
 *
 * `etatNpm` vient de `lectureDeNpm` et distingue le troisième cas : un paquet
 * jamais publié n'est ni une version, ni un silence du registre.
 */
export function etatDeLaRelease({ npm, etatNpm, depot, le } = {}) {
  const surNpm = npm?.version ?? null;
  const versionDuDepot = depot?.version ?? null;
  const jamaisPubliee = etatNpm === 'jamais-publiee';
  return {
    // Jamais publié n'est PAS injoignable : npm a répondu, et sa réponse est
    // « ce nom n'existe pas ». Les confondre accuse le réseau d'un fait établi.
    npmInjoignable: !npm && !jamaisPubliee,
    jamaisPubliee,
    verifieLe: le ?? null,
    surNpm,
    publieeLe: surNpm ? (npm?.time?.[surNpm] ?? null) : null,
    versionDuDepot,
    dernierTag: depot?.dernierTag ?? null,
    commitsDepuisLeTag: depot?.commitsDepuisLeTag ?? null,
    // `null` et non `false` quand npm est muet : « pas en avance » et « je ne
    // sais pas » ne se ressemblent qu'à l'écran. Un paquet jamais publié, lui,
    // est un fait connu : tout ce que le dépôt porte est en avance.
    depotEnAvance: jamaisPubliee
      ? versionDuDepot
        ? true
        : null
      : surNpm && versionDuDepot
        ? surNpm !== versionDuDepot
        : null,
  };
}

/** « publish 0.8.9 », « release v0.8.9 » — le vocabulaire des titres de release. */
const DEMANDE_DE_PUBLICATION = /\b(?:publish|release)\s+v?(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/i;

/**
 * Les cartes OUVERTES qui demandent de publier une version déjà servie par npm.
 *
 * C'est l'issue #68, nommée par le portail au lieu d'être crue sur parole.
 * Aucune accusation quand npm n'a pas répondu : on ne sait pas ce qui est
 * publié, et deviner ici serait le même défaut à l'envers.
 */
export function publicationsDejaFaites(cartes, release) {
  if (!Array.isArray(cartes) || !release?.surNpm || release.npmInjoignable) return [];
  const out = [];
  for (const c of cartes) {
    if (c.etat !== 'OPEN') continue;
    const version = DEMANDE_DE_PUBLICATION.exec(String(c.titre ?? ''))?.[1];
    if (!version) continue;
    const ordre = comparerSemver(version, release.surNpm);
    if (ordre === null || ordre > 0) continue;
    out.push({ numero: c.numero, type: c.type, titre: c.titre, version, url: c.url ?? null });
  }
  return out;
}

// ─── La provenance d'une carte ────────────────────────────────────────────────
//
// Règle du 16/09/2026 : toute issue ou PR ouverte par un agent porte une
// section `## Verified` avec au moins une commande et sa sortie — c'est-à-dire
// DU CODE sous le titre : une portion en ligne (la forme du modèle), un bloc
// clôturé, ou un bloc indenté. Un titre vide ne compte pas, et du texte seul
// non plus : la pastille s'achetait sinon avec cinq caractères. Le critère de
// « écrite par un agent » est VÉRIFIABLE — le pied que les agents posent
// eux-mêmes — et non une intuition sur le style.
//
// Ce que ce critère dit exactement, et rien de plus : TOUTE CARTE QUI PORTE LE
// PIED D'AGENT est concernée. Un humain qui colle ce pied dans son propre corps
// d'issue reçoit donc la pastille. C'est un compromis assumé : le pied est le
// seul signal vérifiable, et une heuristique de style se tromperait bien plus
// souvent, dans les deux sens. Une issue écrite à la main SANS ce pied n'a
// rien à prouver, et c'est le cas courant.

/** Le pied que tout agent de ce dépôt pose au bas de ce qu'il ouvre. */
export function ecritParUnAgent(corps) {
  const t = String(corps ?? '');
  return /generated with[^\n]{0,20}claude code/i.test(t) || /claude-session\s*:/i.test(t);
}

/**
 * Les lignes du corps, chacune sachant si elle appartient à un bloc de code
 * CLÔTURÉ (``` ou ~~~).
 *
 * Un agent qui CITE le modèle de `SKILL.md` dans un bloc de code écrit bien la
 * ligne `## Verified`, sans rien avoir vérifié — et passait pour vérifié. Une
 * ligne dans un bloc n'est donc ni un titre, ni un texte.
 *
 * Le balayage suit CommonMark d'assez près pour ne pas surprendre :
 *   — une clôture s'ouvre avec AU PLUS 3 espaces d'indentation ; à 4, la ligne
 *     appartient déjà à un bloc de code indenté et n'ouvre rien ;
 *   — elle se ferme par le même caractère, au moins autant de marques, et rien
 *     d'autre que des espaces après ;
 *   — un bloc laissé OUVERT court jusqu'à la fin du corps. C'est la règle
 *     CommonMark, et c'est aussi la prudente : une clôture jamais refermée est
 *     un corps qu'on ne sait pas lire, et l'agent le voit tout de suite sous la
 *     forme d'une pastille « no verified facts ». L'inverse — refermer d'office
 *     à la fin du bloc suivant — validerait un `## Verified` qui n'est peut-être
 *     que du texte cité.
 */
function lignesAnnotees(texte) {
  const out = [];
  let cloture = null;
  // Découpage sur `\r?\n`, et c'est tout sauf un détail (constaté en rendant le
  // tableau, 18/09/2026) : GitHub rend les corps en CRLF. Un `\r` traînant à la
  // fin d'une ligne est un TERMINATEUR de ligne pour JavaScript, que `.` ne
  // reconnaît pas — « ## Verified\r » ne satisfaisait donc plus la forme d'un
  // titre, et la clôture d'un bloc ne satisfaisait plus la sienne. Toutes les
  // PR portaient la pastille « no verified facts » alors qu'elles portaient
  // leur section, et un bloc de code y restait ouvert jusqu'au bas du corps.
  for (const ligne of texte.split(/\r?\n/)) {
    const marque = /^ {0,3}(`{3,}|~{3,})/.exec(ligne)?.[1];
    if (cloture) {
      const ferme =
        marque &&
        marque[0] === cloture[0] &&
        marque.length >= cloture.length &&
        /^ {0,3}(?:`{3,}|~{3,})[ \t]*$/.test(ligne);
      out.push({ ligne, dansUnBloc: true });
      if (ferme) cloture = null;
      continue;
    }
    if (marque) {
      cloture = marque;
      out.push({ ligne, dansUnBloc: true });
      continue;
    }
    out.push({ ligne, dansUnBloc: false });
  }
  return out;
}

/** `## Verified` : un titre markdown, hors bloc, indenté d'au plus 3 espaces. */
const TITRE = /^ {0,3}(#{1,6})[ \t]*(.*)$/;

/**
 * Une SECTION « Verified » qui porte VRAIMENT quelque chose.
 *
 * La règle dit « au moins une commande et sa sortie ». Le titre seul ne la
 * satisfait pas, et un `## Verified` vide passait pourtant — la pastille
 * s'achetait avec cinq caractères, ce qui vidait la règle de son objet.
 *
 * La forme minimale d'« une commande et sa sortie » est DU CODE : un bloc
 * clôturé (```…```), un bloc indenté de 4 espaces, ou une portion de code en
 * ligne (`` `npm view …` → 0.8.9 ``). Cette troisième forme n'est pas une
 * tolérance : c'est CELLE DU MODÈLE de `SKILL.md`, donc celle que portent les
 * cartes correctement remplies. L'exiger en bloc les recalerait toutes.
 *
 * Du texte seul, lui, ne compte pas : c'est une affirmation, et la règle existe
 * précisément contre les affirmations. La section court jusqu'au prochain titre
 * de niveau INFÉRIEUR OU ÉGAL au sien, ou jusqu'à la fin du corps — un
 * sous-titre reste dedans.
 *
 * L'indentation du titre est bornée à 3 espaces, comme en markdown : à 4
 * espaces ou après une tabulation, la ligne est un bloc de code indenté et non
 * un titre. Sans cette borne, coller le modèle de `SKILL.md` en le décalant
 * suffisait à passer pour vérifié.
 */
export function porteDesFaitsVerifies(corps) {
  const lignes = lignesAnnotees(String(corps ?? ''));
  for (let i = 0; i < lignes.length; i += 1) {
    if (lignes[i].dansUnBloc) continue;
    const titre = TITRE.exec(lignes[i].ligne);
    if (!titre || !/^verified\b/i.test(titre[2].trim())) continue;
    const niveau = titre[1].length;
    for (let j = i + 1; j < lignes.length; j += 1) {
      const { ligne, dansUnBloc } = lignes[j];
      if (dansUnBloc) return true;
      const suivant = TITRE.exec(ligne);
      if (suivant && suivant[1].length <= niveau) break;
      // Un bloc de code INDENTÉ : quatre espaces ou une tabulation, du contenu.
      if (/^(?: {4}|\t)[ \t]*\S/.test(ligne)) return true;
      // Du code EN LIGNE, la forme du modèle : `commande` → sortie.
      if (/`[^`\n]*\S[^`\n]*`/.test(ligne)) return true;
    }
  }
  return false;
}

/** Les cartes ouvertes par un agent qui n'apportent aucun fait vérifié. */
export function sansFaitsVerifies(cartes) {
  if (!Array.isArray(cartes)) return [];
  return cartes.filter((c) => c.etat === 'OPEN' && c.parUnAgent && !c.faitsVerifies);
}

// ─── Où en est la revue d'une PR ──────────────────────────────────────────────
//
// Le tableau disait « In review » et rien d'autre : ni par qui, ni combien de
// passes, ni le dernier verdict (issue #128). Une PR relue quatre fois et une
// PR que personne n'a ouverte s'affichaient pareil, et les issues qu'une PR
// ferme n'en disaient pas davantage.
//
// La source est un FAIT écrit là où la revue se passe : un commentaire de la
// PR, dans une forme stable. Le corps est lu aussi, pour les PR d'avant cette
// règle qui portent la section dedans.
//
//   ## Review pass 2 (Reviewer C, 2026-09-18)
//
//   Verdict: approve (0 blocking, 0 important, 4 minor)
//
// Rien n'est deviné : un en-tête qui ne suit pas la forme est IGNORÉ et dit
// dans les avertissements, jamais interprété au jugé. Ce portail existe contre
// les affirmations ; il ne va pas en fabriquer une sur l'état d'une revue.

/**
 * `## Review pass <N> (<relecteur>, <AAAA-MM-JJ>)` — le titre, exactement.
 *
 * Deux libertés et deux exigences, qu'il vaut mieux écrire que découvrir
 * (revue C de la PR #175) :
 *   — le NIVEAU du titre est libre, de `#` à `######` : la convention pose
 *     `##`, un commentaire qui remonte d'un cran reste lu ;
 *   — la casse est libre ;
 *   — le numéro est en CHIFFRES et la date en AAAA-MM-JJ ; « pass two » ou
 *     « hier » sont refusés et dits, jamais devinés ;
 *   — le nom du relecteur ne contient ni virgule ni parenthèse, puisque ce
 *     sont elles qui délimitent les trois champs.
 */
const ENTETE_PASSE = /^review pass\s+(\d+)\s*\(\s*([^,()]+?)\s*,\s*(\d{4}-\d{2}-\d{2})\s*\)$/i;

/**
 * `Verdict: <approve|request_changes> (<b> blocking, <i> important, <m> minor)`.
 *
 * Elle doit être la PREMIÈRE ligne non vide sous le titre : le texte libre
 * vient après, jamais avant. C'est voulu — chercher le verdict n'importe où
 * sous le titre le ferait trouver dans une phrase qui le CITE (« la passe 1
 * disait Verdict: approve »), et la carte annoncerait un verdict que personne
 * n'a rendu. Une ligne qui ne suit pas la forme fait une passe ignorée, dite
 * dans `warnings` (revue C de la PR #175).
 */
const LIGNE_VERDICT =
  /^verdict:\s*(approve|request_changes)\s*\(\s*(\d+)\s+blocking\s*,\s*(\d+)\s+important\s*,\s*(\d+)\s+minor\s*\)$/i;

/**
 * La taille d'une page de commentaires que `gh` rend avec une PR.
 *
 * Ce n'est pas une mesure : `gh pr list --json comments` ne documente aucune
 * garantie de complétude, et ce dépôt n'a pas de PR assez bavarde pour le
 * montrer (la plus longue liste y fait sept commentaires, PR #45, comparée à
 * `gh pr view 45 --json comments` : mêmes sept, mêmes identifiants). Cent est
 * la page usuelle de l'API GraphQL. Une liste qui l'atteint est donc traitée
 * comme PEUT-ÊTRE tronquée et le dit, plutôt que de laisser une carte retomber
 * en silence sur « pas encore relue ».
 */
const COMMENTAIRES_PAR_PAGE = 100;

/** Rien à dire : aucune passe lue, la PR attend encore sa première relecture. */
const AUCUNE_REVUE = {
  passes: 0,
  lastReviewer: null,
  lastDate: null,
  lastVerdict: null,
  counts: null,
  status: 'in-review',
};

/**
 * L'état de la revue d'une PR, lu dans son corps et dans ses commentaires.
 *
 * Prend une chaîne ou une liste de chaînes (le corps d'abord, puis les
 * commentaires dans leur ordre). Rend toujours un objet — jamais `null` —, où
 * `passes` est le NUMÉRO de la dernière passe (0 quand il n'y en a aucune) et
 * `status` vaut :
 *
 *   - `in-review` — aucune passe lisible : personne n'a encore rendu de
 *     verdict, ou ce qui est écrit ne suit pas la forme (et `warnings` le dit) ;
 *   - `approved-waiting-merge` — la DERNIÈRE passe approuve, sans rien de
 *     bloquant ni d'important. C'est la condition d'arrêt de la boucle de revue
 *     du CLAUDE.md, mot pour mot ;
 *   - `changes-requested` — tout le reste.
 *
 * Le mot du verdict ET les comptes doivent s'accorder pour peindre en vert : un
 * « request_changes (0 blocking, 0 important) » se contredit lui-même, et entre
 * deux lectures d'un même fait la page prend la plus sévère. Un faux vert sur
 * un tableau de suivi est exactement ce que ce portail existe pour empêcher.
 *
 * Les blocs de code sont retirés avant lecture, comme pour `## Verified` : une
 * passe CITÉE en exemple — il y en a dans les tests de ce portail — n'est pas
 * une passe rendue.
 */
export function reviewState(corpsEtCommentaires) {
  const sources = Array.isArray(corpsEtCommentaires) ? corpsEtCommentaires : [corpsEtCommentaires];
  const passes = [];
  const warnings = [];

  for (const source of sources) {
    const lignes = lignesAnnotees(String(source ?? ''));
    for (let i = 0; i < lignes.length; i += 1) {
      if (lignes[i].dansUnBloc) continue;
      const titre = TITRE.exec(lignes[i].ligne);
      if (!titre) continue;
      const texte = titre[2].trim();
      if (!/^review pass\b/i.test(texte)) continue;
      const entete = ENTETE_PASSE.exec(texte);
      if (!entete) {
        warnings.push(`unreadable review pass header: "${texte}"`);
        continue;
      }
      // Le verdict est la première ligne qui DIT quelque chose sous le titre.
      // Absent ou mal formé, la passe ne compte pas : un titre seul ne dit pas
      // où en est la revue.
      let verdict = null;
      for (let j = i + 1; j < lignes.length; j += 1) {
        const { ligne, dansUnBloc } = lignes[j];
        if (dansUnBloc || ligne.trim() === '') continue;
        if (TITRE.test(ligne)) break;
        verdict = LIGNE_VERDICT.exec(ligne.trim());
        break;
      }
      if (!verdict) {
        warnings.push(`review pass ${entete[1]} has no readable verdict line`);
        continue;
      }
      passes.push({
        numero: Number(entete[1]),
        reviewer: entete[2].trim(),
        date: entete[3],
        verdict: verdict[1].toLowerCase(),
        counts: {
          blocking: Number(verdict[2]),
          important: Number(verdict[3]),
          minor: Number(verdict[4]),
        },
      });
    }
  }

  if (passes.length === 0) return { ...AUCUNE_REVUE, warnings };

  // La DERNIÈRE passe est celle du plus grand numéro : les commentaires
  // arrivent dans l'ordre, mais une passe recopiée dans le corps d'une vieille
  // PR n'a pas d'ordre du tout. À numéro égal, la dernière lue gagne.
  let derniere = passes[0];
  for (const p of passes) if (p.numero >= derniere.numero) derniere = p;
  const propre = derniere.counts.blocking === 0 && derniere.counts.important === 0;

  return {
    // Le NUMÉRO atteint, pas le nombre de sections lues : la session ne poste
    // qu'un commentaire par passe, et une PR reprise dont seule la passe 3 est
    // recopiée en est bien à sa troisième. « Pass 1 » sur une revue qui en a
    // vu trois serait un fait faux, et la boucle a un budget de quatre.
    passes: derniere.numero,
    lastReviewer: derniere.reviewer,
    lastDate: derniere.date,
    lastVerdict: derniere.verdict,
    counts: derniere.counts,
    status:
      derniere.verdict === 'approve' && propre ? 'approved-waiting-merge' : 'changes-requested',
    warnings,
  };
}

// ─── La gravité ───────────────────────────────────────────────────────────────
//
// Vingt-et-un parcours rouges affichés à l'identique, c'est du bruit — et le
// bruit décourage d'ouvrir la page. La gravité se DÉDUIT de faits, jamais d'un
// réglage à la main : est-ce qu'une capacité exigée tombe, est-ce que le rouge
// est frais ou déjà vieux.
//
// Cette liste vivait dans le rendu, hors de portée d'un test. C'est pourtant
// elle qui décide de ce qu'on regarde en premier.

const RANG = { haute: 0, moyenne: 1, basse: 2 };

/** Un rouge de moins de deux jours est une régression ; au-delà, c'est une dette. */
const JEUNE_MS = 2 * 24 * 60 * 60 * 1000;

/** Au-delà de deux semaines, un rouge n'est plus une régression : c'est un choix. */
const VIEUX_MS = 14 * 24 * 60 * 60 * 1000;

/** Au-delà de ce nombre de minutes par PR, l'attente devient le sujet. */
const SEUIL_PRIX_MIN = 25;

/** Et au-delà de cette hausse sur la fenêtre, la dérive est dite avant d'être subie. */
const SEUIL_HAUSSE_PRIX = 25;

export function ecartsDe(s, historique = [], maintenant = Date.now()) {
  const out = [];
  if (!s) return out;
  const r = s.resume ?? {};
  const registre = s.capacites?.registre ?? [];
  const mem = s.memoire ?? null;

  // ── Ce qui passe avant le produit lui-même : un portail qui MENT. Tant que
  // le tableau raconte un travail fantôme, aucun des écarts suivants n'est
  // croyable. Quatre jours d'issue #68 l'ont montré.
  const release = s.release ?? null;
  const cartes = s.chantiers?.cartes ?? null;

  const dejaPubliees = publicationsDejaFaites(cartes, release);
  if (dejaPubliees.length > 0) {
    out.push({
      gravite: 'haute',
      titre: `${dejaPubliees.length} open card(s) ask to publish a version already on npm`,
      detail: `npm serves ${release.surNpm}. These cards describe work that is already done, and the board has been carrying them as work to do. Close them, or correct the version they name.`,
      quoi: dejaPubliees.map((c) => `#${c.numero} ${c.titre}`),
    });
  }

  const sansFaits = sansFaitsVerifies(cartes);
  if (sansFaits.length > 0) {
    out.push({
      gravite: 'haute',
      titre: `${sansFaits.length} open card(s) written by an agent carry no verified facts`,
      detail: `An agent opened them and wrote no "Verified" section, so nothing in them was checked against npm, git or a test run. That is exactly how a version that shipped a week earlier became a task on this board.`,
      quoi: sansFaits.map((c) => `#${c.numero} ${c.titre}`),
    });
  }

  // Une absence de mesure n'est pas un feu vert. Moyenne, jamais haute : le
  // registre injoignable est une panne de réseau, pas une panne du produit.
  if (release?.npmInjoignable) {
    out.push({
      gravite: 'moyenne',
      titre: `npm was unreachable at the last collection`,
      detail: `Nothing is known about what is published, so nothing is claimed. The release block shows the hole rather than the previous answer without its date.`,
      quoi: release.verifieLe ? [release.verifieLe] : [],
    });
  }

  // ── Le produit. Un paquet mal couvert est une question d'ingénieur ;
  // une preuve de capacité tombée est une promesse rompue.
  //
  // Trois familles, et la hiérarchie entre elles est tout le lot : un ÉCHEC
  // réveille, une ABSENCE informe. Confondre les deux — ce que faisait le mot
  // « cassée » — envoyait chercher un bug là où personne n'avait écrit de test.
  const MOT_NIVEAU = { ecran: 'screen', moteur: 'engine' };
  const tombees = [];
  for (const c of registre) {
    if (!c.exigee) continue;
    for (const n of ['ecran', 'moteur']) {
      if (c[n]?.etat === 'echouee') tombees.push(`${c.nom} · ${MOT_NIVEAU[n]}`);
    }
  }
  if (tombees.length > 0) {
    out.push({
      gravite: 'haute',
      titre: `${tombees.length} capability proof(s) FAILED at the last measurement`,
      detail: `The level is named because it changes everything: a fallen SCREEN means the journey no longer chains, the buttons; a fallen ENGINE means the promised thing is no longer done.`,
      quoi: tombees,
    });
  }

  // Le trou que le mot « prouvée » cachait : la façade est vérifiée, le moteur
  // n'est testé par personne. Moyenne, jamais haute — rien n'est cassé.
  const sansMoteur = registre.filter(
    (c) => c.exigee && c.moteur?.etat === 'absente' && c.ecran?.etat !== 'absente',
  );
  if (sansMoteur.length > 0) {
    out.push({
      gravite: 'moyenne',
      titre: `${sansMoteur.length} required capability(ies) with no ENGINE proof`,
      detail: `A screen journey passes: the buttons chain together. Nothing says the thing is done behind. That is exactly what the word "proven" let people believe.`,
      quoi: sansMoteur.map((c) => c.nom),
    });
  }

  const dorment = [];
  for (const c of registre) {
    if (!c.exigee) continue;
    for (const n of ['ecran', 'moteur']) {
      if (c[n]?.etat === 'ignoree' || c[n]?.etat === 'jamais jouee') {
        dorment.push(`${c.nom} · ${MOT_NIVEAU[n]}`);
      }
    }
  }
  if (dorment.length > 0) {
    out.push({
      gravite: 'moyenne',
      titre: `${dorment.length} capability proof(s) did not run`,
      detail: `A test claims them, no run played it, skipped, or never reached. The proof exists and sleeps: that is a hole in the measurement, not in the product.`,
      quoi: dorment,
    });
  }

  // L'instabilité d'une preuve n'a pas son écart à elle : la section mémoire
  // la remonte déjà, test par test, et la répéter ici doublerait la même ligne
  // sous deux titres.

  const jamais = registre.filter(
    (c) => c.ecran?.etat === 'absente' && c.moteur?.etat === 'absente' && !(c.nonDit?.length > 0),
  );
  if (jamais.length > 0) {
    out.push({
      // Basse à dessein : c'est un plan de travail, pas une alerte. La monter
      // en haute noierait les vraies régressions sous une liste qui ne bouge
      // que lentement.
      gravite: 'basse',
      titre: `${jamais.length} capability(ies) out of ${registre.length} have no proof at all, neither screen nor engine`,
      detail: `This is the list of what we believe is shipped. It is meant to shrink.`,
      quoi: jamais.map((c) => c.nom),
    });
  }

  // ── La mémoire. Un test cassé se répare ; un test instable se subit.
  if (mem?.instables > 0) {
    out.push({
      gravite: 'moyenne',
      titre: `${mem.instables} flaky test(s)`,
      detail: `Green and red within their window. No isolated run gives them away: they pass for green every time they pass.`,
      quoi: (mem.pires ?? []).map((e) => e.titre ?? e.cle),
    });
  }

  // `regressions` et non `listeCasses` : un test qui passait et qui tombe a un
  // historique `vr`, donc le verdict « instable » — il sortait de la liste des
  // cassés, et la seule vraie régression que ce lot devait attraper échappait à
  // l'alerte. Elle n'y serait entrée qu'une fois devenue « cassée », avec une
  // date déjà trop vieille pour être signalée (revue Codex du 11/09).
  const frais = (mem?.regressions ?? []).filter(
    (e) => e.rougeDepuis && maintenant - Date.parse(e.rougeDepuis) < JEUNE_MS,
  );
  if (frais.length > 0) {
    out.push({
      gravite: 'haute',
      titre: `${frais.length} test(s) turned red in the last two days`,
      detail: `A fresh red is a regression: something moved, and we know when. An old red is a debt we have learned not to see, the two are not handled the same way.`,
      quoi: frais.map((e) => e.titre ?? e.cle),
    });
  }

  // Le pendant du précédent, et sa raison d'être : le rouge qui traîne ne
  // déclenche rien parce qu'il ne bouge plus. Il ne réveille donc personne
  // (gravité moyenne, jamais haute — c'est `alertes()` qui trie), mais il est
  // NOMMÉ, sans quoi ces tests-là finissent invisibles à force d'être là.
  const vieux = (mem?.regressions ?? []).filter(
    (e) => e.rougeDepuis && maintenant - Date.parse(e.rougeDepuis) > VIEUX_MS,
  );
  if (vieux.length > 0) {
    out.push({
      gravite: 'moyenne',
      titre: `${vieux.length} test(s) red for more than 14 days`,
      detail: `Two weeks without a repair is no longer a regression: it is a decision nobody took. Repair, or delete the test along with the capability it proved.`,
      quoi: vieux.map((e) => e.titre ?? e.cle),
    });
  }

  // ── Le banc. Il DÉTECTE déjà les régressions et les écrit ; il ne manquait
  // que quelqu'un pour les lire.
  const banc = verdictDuBanc(s.banc?.dernierRun);
  if (banc.regressions.length > 0) {
    out.push({
      gravite: 'haute',
      titre: `${banc.regressions.length} bench section(s) REGRESSED`,
      detail: `The bench measured it and wrote it down. The nightly measurement ignores it on purpose so as not to stop, here is where it gets said.`,
      quoi: banc.regressions,
    });
  }
  if (banc.erreurs.length > 0) {
    out.push({
      gravite: 'haute',
      titre: `${banc.erreurs.length} bench section(s) COULD NOT run`,
      detail: `A fault, not a slowdown. These sections measure nothing any more, so they can guard nothing any more.`,
      quoi: banc.erreurs,
    });
  }
  // `absent` n'est pas « tout va bien ». L'écran le disait ; l'alerte ne le
  // lisait pas, et pouvait fermer son billet une nuit où le banc avait planté
  // avant d'écrire une ligne (revue Codex, 3e passe). Haute, comme une section
  // en panne : c'est la même panne, à l'échelle du banc entier.
  //
  // Seulement quand le banc était ATTENDU — la mesure nocturne le lance
  // toujours. Un rendu local ou un dépôt neuf n'ont pas de rapport et n'ont
  // rien à se reprocher : crier là ferait une alerte permanente que tout le
  // monde apprendrait à ignorer.
  if (banc.absent && s.banc?.attendu === true) {
    out.push({
      gravite: 'haute',
      titre: `The bench left no report`,
      detail: `It crashed before writing, or did not run. None of its sections measured anything last night: this is not a green, it is a hole.`,
      quoi: [],
    });
  }

  // ── Le dépôt. Réel, mais jamais au-dessus du produit.
  // Même définition que la page Journeys, une seule fois : l'écart et la
  // couleur d'une ligne ne peuvent pas diverger.
  // Une panne de LECTURE se dit avant tout ce qu'on croit avoir lu. Sans elle,
  // un workflow dont la forme a changé faisait afficher « 30 parcours jamais
  // joués » — un diagnostic faux, et adressé au mauvais fichier.
  const illisibles = (s.ci ?? []).filter((w) => w.parcoursIllisibles);
  if (illisibles.length > 0) {
    out.push({
      gravite: 'haute',
      titre: `${illisibles.length} workflow(s) unreadable: the journeys they play cannot be told`,
      detail: `The file names the e2e directory, but neither a named spec nor the sweep the portal knows how to read. Nothing is said about those journeys: this is a hole in the portal's reading, not a dead journey in the repository. Fix the reader, or put the sweep back in the shape it knows.`,
      quoi: illisibles.map((w) => w.fichier),
    });
  }

  const nonJoues = (s.parcours ?? []).filter((p) => etatDunParcours(p).rouge);
  if (nonJoues.length > 0) {
    const cas = nonJoues.reduce((a, p) => a + p.cas, 0);
    out.push({
      gravite: 'haute',
      titre: `${nonJoues.length} journeys out of ${r.specsE2e} are never played by the CI`,
      detail: `${cas} test cases written, versioned, and run by no continuous integration. These are the user journeys, precisely what a regression breaks first and what a unit test does not see.`,
      quoi: nonJoues.map((p) => p.nom),
    });
  }

  const nonMesures = (s.paquets ?? []).filter((p) => !p.couverture && p.tests?.cas > 0);
  if (nonMesures.length > 0) {
    out.push({
      gravite: 'haute',
      titre: `${nonMesures.length} packages carry tests whose coverage has never been measured`,
      detail: `The coverage configuration had always existed; the package that runs it was not installed. None of these packages can say how much of its code its tests go through.`,
      quoi: nonMesures.map((p) => p.nom),
    });
  }

  const ci = s.ci ?? [];
  if (ci.length > 0 && ci.every((w) => !w.lanceBanc)) {
    out.push({
      gravite: 'haute',
      titre: `No workflow runs the bench`,
      detail: `The bench already exits with an error on a metric regression, a gate that works and that nobody walks through. A regression of the approval gate can therefore ship without a word.`,
      quoi: (s.banc?.sections ?? []).map((b) => b.id),
    });
  }

  // ── Le prix d'une PR. Pas une curiosité de performance : le jour où
  // attendre son merge devient insupportable, quelqu'un désactive une suite,
  // et personne ne demande la permission avant. Le coût est donc l'indicateur
  // AVANCÉ de la prochaine porte qu'on va retirer.
  //
  // `null` (GitHub sans réponse) ne pose RIEN : une absence de mesure n'est pas
  // une CI gratuite.
  const prix = s.prixCi ?? null;
  if (prix?.medianeRecente != null && prix.medianeRecente > SEUIL_PRIX_MIN) {
    out.push({
      gravite: 'haute',
      titre: `The CI costs ${prix.medianeRecente} min per pull request`,
      detail: `Median of the last ${Math.min(prix.runs, 10)} green runs, queue time included. Past twenty minutes or so, the wait stops being bearable and it is the content of the CI that ends up being trimmed, not the time it takes.`,
      quoi: [],
    });
  }
  if (prix?.hausse != null && prix.hausse > SEUIL_HAUSSE_PRIX) {
    out.push({
      gravite: 'moyenne',
      titre: `The CI grew ${prix.hausse}% over the window`,
      detail: `First half of the runs against the second half. A drift is repaired while it is small; once settled, it becomes the normal nobody argues with any more.`,
      quoi: [],
    });
  }

  if (ci.length > 0 && !ci.some((w) => w.lanceCouverture)) {
    out.push({
      gravite: 'moyenne',
      titre: `No workflow measures coverage`,
      detail: `Without continuous measurement, coverage is a number from the day someone thought to run it, not a property of the repository.`,
      quoi: [],
    });
  }

  const nus = (s.paquets ?? []).filter((p) => p.tests?.cas === 0 && p.tests?.e2e === 0);
  if (nus.length > 0) {
    out.push({
      gravite: 'moyenne',
      titre: `${nus.length} packages with no test at all`,
      detail: `A package without tests is not necessarily a problem, some only carry types or configuration. Those deserve to be named so we stop asking the question.`,
      quoi: nus.map((p) => p.nom),
    });
  }

  if ((historique ?? []).length < 2) {
    out.push({
      gravite: 'basse',
      titre: `The history is only just starting`,
      detail: `${(historique ?? []).length} collection(s) recorded. The questions "how often does it run" and "how regularly" become answerable as soon as the CI collects on every run.`,
      quoi: [],
    });
  }

  // Tri STABLE par gravité : à gravité égale, l'ordre de déclaration est
  // conservé, et il place le produit avant le dépôt.
  return out
    .map((e, i) => ({ e, i }))
    .sort((a, b) => RANG[a.e.gravite] - RANG[b.e.gravite] || a.i - b.i)
    .map((x) => x.e);
}

/**
 * Ce que le dernier passage du banc a trouvé.
 *
 * La mesure nocturne lance le banc avec `|| true` — délibérément, pour
 * ENREGISTRER une régression plutôt que d'arrêter la mesure — et range son
 * rapport. Mais personne ne le lisait : le portail n'affichait que les baselines
 * ACCEPTÉES, si bien qu'une régression de métrique passait la nuit sans un mot,
 * alors même que le banc l'avait détectée et écrite (revue Codex du 11/09).
 *
 * `absent` n'est pas « tout va bien » : c'est le trou de mesure que ce portail
 * refuse de peindre en vert. Et une section qui n'a PAS PU tourner est rangée à
 * part d'une section qui a ralenti — les confondre ferait chercher un
 * ralentissement là où il y a une panne.
 */
export function verdictDuBanc(rapport) {
  if (!rapport?.diffs) return { absent: true, regressions: [], erreurs: [], mesureLe: null };
  const diffs = rapport.diffs ?? [];
  return {
    absent: false,
    regressions: diffs.filter((d) => d.regressed && !d.error).map((d) => d.label ?? d.sectionId),
    erreurs: diffs.filter((d) => d.error).map((d) => d.label ?? d.sectionId),
    mesureLe: rapport.run?.startedAt ?? null,
  };
}

/** Ce qui mérite de réveiller quelqu'un. Rien d'autre. */
export function alertes(ecarts) {
  return (ecarts ?? []).filter((e) => e.gravite === 'haute');
}

// ─── La mémoire, test par test ────────────────────────────────────────────────
//
// `history.ndjson` garde une ligne par COLLECTE : des totaux. Ils ne savent pas
// répondre à « ce test a tourné 47 fois, échoué 3 fois ». Or tout ce qui compte
// vient du temps — la tendance, l'âge d'un problème, et surtout l'instabilité,
// qui est indétectable dans une seule exécution. La calculer par run, comme le
// fait `sortDuCas`, est presque un contresens : ça ne voit qu'une reprise
// immédiate, jamais un test qui tombe un jour sur trois.
//
// Un enregistrement par test, pas un par exécution : le fichier reste borné
// (quelques milliers de lignes) là où l'autre forme grossirait de six mille
// lignes par nuit et deviendrait invivable en un mois.

/** La lettre qui code un sort dans la fenêtre `recents`. */
const LETTRE = { vert: 'v', rouge: 'r', ignoré: 'i', instable: 'f' };
const SORT_DE_LETTRE = { v: 'vert', r: 'rouge', i: 'ignoré', f: 'instable' };

/**
 * L'identité d'un test à travers le temps.
 *
 * Le fichier ET le titre complet : deux tests peuvent porter le même titre dans
 * deux fichiers, et un titre seul ferait fusionner leurs historiques.
 */
export function cleDuTest(fichier, titre) {
  return `${fichier}::${titre}`;
}

/**
 * Range une salve de résultats dans la mémoire existante.
 *
 * Trois règles, et la troisième est celle qu'on oublie :
 *   - un test jamais vu ouvre un enregistrement ;
 *   - un test revu incrémente son compteur et pousse une lettre dans sa fenêtre ;
 *   - **un test connu ABSENT de la salve ne bouge pas.** Il n'a pas tourné —
 *     compter un tour, ou pire un échec, ferait mentir tous les taux. C'est
 *     exactement ce qui arrive quand une exécution ne joue qu'une partie de la
 *     suite, ce qui est le cas normal ici.
 */
export function fusionnerEssais(
  existants,
  nouveaux,
  { max = 30, le = null, execution = null } = {},
) {
  const parCle = new Map((existants ?? []).map((e) => [e.cle, { ...e }]));

  // Deux cas homonymes dans la MÊME salve sont deux tests — un `test.each`
  // dont le titre ne distingue pas ses paramètres. Fusionnés, un cas toujours
  // vert et un cas toujours rouge faisaient UN test « instable », avec une
  // régression fraîche inventée chaque nuit (revue Codex, 3e passe). Le
  // deuxième prend le rang `#2`, le troisième `#3` : l'ordre dans le fichier
  // est stable d'une nuit à l'autre, donc la clé aussi. Le premier garde sa
  // clé nue — aucun historique existant ne bouge.
  //
  // Limite assumée : insérer un homonyme AVANT les autres décale leurs rangs,
  // et chacun hérite de l'historique de son prédécesseur pour une nuit. C'est
  // le prix d'une clé sans identifiant — un `test.each` qui met son paramètre
  // dans le titre n'a pas ce problème, et c'est la forme à préférer.
  const vus = new Map();

  for (const n of nouveaux ?? []) {
    const lettre = LETTRE[n.sort];
    // Un sort qu'on ne sait pas coder n'entre pas dans la mémoire : mieux vaut
    // un trou qu'une lettre inventée sur laquelle on calculera des taux.
    if (!lettre) continue;

    const cleNue = n.cle ?? cleDuTest(n.fichier, n.titre);
    const rang = (vus.get(cleNue) ?? 0) + 1;
    vus.set(cleNue, rang);
    const cle = rang === 1 ? cleNue : `${cleNue}#${rang}`;
    const e = parCle.get(cle) ?? {
      cle,
      fichier: n.fichier ?? null,
      titre: n.titre ?? null,
      tours: 0,
      echecs: 0,
      recents: '',
      dernierTourLe: null,
      dernierEchecLe: null,
      rougeDepuis: null,
      // La dernière réparation observée : quand le rouge a commencé, quand il
      // s'est arrêté. Les deux, sinon la durée ne se calcule pas.
      dernierRougeDepuis: null,
      repareLe: null,
      // L'exécution qui a VU ce test rouge la dernière fois. C'est le seul
      // chemin entre un nom de test dans un tableau et ce que l'utilisateur
      // aurait vu : le rapport du run, sa trace et sa capture d'écran.
      dernierRougeExecution: null,
    };

    // Le sort du tour PRÉCÉDENT, lu avant d'écrire celui-ci : c'est lui qui
    // permet de dire si le test vient de basculer, ou s'il était déjà là.
    const precedent = e.recents.at(-1) ?? null;

    e.tours += 1;
    e.recents = (e.recents + lettre).slice(-max);
    e.dernierTourLe = n.le ?? le ?? e.dernierTourLe;
    if (n.dureeMs != null) e.dureeMs = n.dureeMs;

    if (n.sort === 'rouge') {
      e.echecs += 1;
      e.dernierEchecLe = e.dernierTourLe;
      // Où aller voir. Un tour rouge joué SANS exécution connue (une mesure
      // locale) ne pose rien et n'efface rien : mieux vaut le dernier lien
      // vivant qu'un lien mort, et un rendu local ne doit pas faire disparaître
      // la piste laissée par la mesure nocturne.
      e.dernierRougeExecution = n.execution ?? execution ?? e.dernierRougeExecution ?? null;
      // L'âge du problème COURANT, pas celui du premier échec de l'histoire :
      // un test cassé en juillet, réparé, recassé hier a un problème d'un jour.
      //
      // Et seulement sur une BASCULE OBSERVÉE. « Passé au rouge » suppose qu'on
      // l'a vu passant juste avant. Dater le premier tour d'un test inconnu
      // donnerait la date où on a commencé à regarder — la première collecte a
      // fait exactement ça, et a présenté vingt-deux rouges anciens comme des
      // régressions du jour. Dater un rouge qui succède à un rouge serait
      // l'erreur inverse : ça rajeunirait le problème à chaque nuit.
      if (!e.rougeDepuis && (precedent === 'v' || precedent === 'f')) {
        e.rougeDepuis = e.dernierTourLe;
      }
    } else if (n.sort === 'vert') {
      // Un rouge DATÉ qui repasse au vert est une réparation observée de bout
      // en bout : on a vu la casse et on voit la remise en état. C'est la seule
      // forme qui donne une durée honnête — d'où la conservation du point de
      // départ, que `rougeDepuis` s'apprête à perdre.
      //
      // Une seule réparation gardée, la dernière : garder toute la suite
      // ferait grossir `tests.ndjson` sans rien ajouter au chiffre qu'on lit.
      if (e.rougeDepuis) {
        e.dernierRougeDepuis = e.rougeDepuis;
        e.repareLe = e.dernierTourLe;
      }
      e.rougeDepuis = null;
    }

    parCle.set(cle, e);
  }

  return [...parCle.values()].sort((a, b) => a.cle.localeCompare(b.cle));
}

/**
 * Ce que la mémoire d'un test dit de lui.
 *
 * `instable` ne se prononce QUE sur plusieurs exécutions : un test qui a été
 * vert et rouge dans sa fenêtre est instable, quoi qu'il ait fait la dernière
 * fois. C'est la seule définition qui attrape le test qui tombe un jour sur
 * trois — celui qui use une équipe et qu'aucun run isolé ne dénonce.
 */
export function instabiliteDe(enr) {
  const recents = String(enr?.recents ?? '');
  const utiles = [...recents].filter((c) => c === 'v' || c === 'r' || c === 'f');
  if (utiles.length === 0) return { verdict: 'inconnu', tauxEchec: null, fenetre: 0 };

  const rouges = utiles.filter((c) => c === 'r').length;
  const verts = utiles.filter((c) => c === 'v').length;
  const flottants = utiles.filter((c) => c === 'f').length;
  const tauxEchec = Number(((rouges / utiles.length) * 100).toFixed(1));

  let verdict;
  if (rouges === utiles.length) verdict = 'cassé';
  else if (rouges > 0 || flottants > 0) verdict = 'instable';
  else verdict = 'sûr';

  return { verdict, tauxEchec, fenetre: utiles.length, rouges, verts };
}

/**
 * Les tests qui sont rouges MAINTENANT et dont on a vu la bascule.
 *
 * Indépendant du verdict d'instabilité, et c'est tout l'objet : un test qui
 * passait hier et tombe aujourd'hui a un historique `vr`, donc il est
 * « instable » au sens de la fenêtre. Le chercher parmi les seuls « cassés »
 * revenait à ne le voir qu'une fois cassé pour de bon — trop tard, et avec une
 * date de bascule devenue trop ancienne pour alerter qui que ce soit.
 *
 * Deux conditions, et les deux comptent : le dernier tour est rouge (le
 * problème est ACTUEL), et `rougeDepuis` est posé (la bascule a été OBSERVÉE,
 * on ne date pas un rouge qu'on n'a jamais vu vert).
 */
export function regressionsFraiches(enregistrements) {
  return (enregistrements ?? []).filter((e) => dernierSort(e) === 'rouge' && e.rougeDepuis);
}

/** Le sort du dernier tour connu, lu dans la fenêtre. */
export function dernierSort(enr) {
  const recents = String(enr?.recents ?? '');
  return SORT_DE_LETTRE[recents.at(-1)] ?? null;
}

const JOUR_MS = 24 * 60 * 60 * 1000;

/**
 * Combien de temps un test reste cassé, quand il finit par être réparé.
 *
 * Le chiffre qui manquait : « 22 tests rouges » ne dit pas si on répare en un
 * jour ou jamais. Deux dépôts avec le même nombre de rouges et des temps de
 * réparation de 1 et de 40 jours ne sont pas du tout dans le même état.
 *
 * La MÉDIANE et pas la moyenne : une seule réparation oubliée pendant six mois
 * tire une moyenne vers le haut et fait croire que c'est la normale. La médiane
 * dit ce qui arrive à la moitié des cas, et ne bouge pas d'un accident.
 *
 * N'entrent ici que les réparations observées de bout en bout — casse VUE puis
 * remise en état vue. Une durée partant de la première fois qu'on a regardé
 * mesurerait notre retard à installer la mesure, pas le leur à réparer.
 */
export function dureesDeReparation(memoire) {
  const durees = (memoire ?? [])
    .map((e) => {
      if (!e?.repareLe || !e?.dernierRougeDepuis) return null;
      const de = Date.parse(e.dernierRougeDepuis);
      const a = Date.parse(e.repareLe);
      if (!Number.isFinite(de) || !Number.isFinite(a) || a < de) return null;
      return Number(((a - de) / JOUR_MS).toFixed(2));
    })
    .filter((d) => d != null)
    .sort((a, b) => a - b);

  return { durees, mediane: medianeDe(durees) };
}

/**
 * L'évolution d'un chiffre de l'historique sur une fenêtre de jours.
 *
 * Deux exclusions, et les deux sont des refus de mentir :
 *   - les collectes `local` — lancées sur un poste, sur un arbre qui n'est pas
 *     main, souvent partielles. Mélangées aux mesures nocturnes, elles font des
 *     décrochages qui ne correspondent à aucun changement du dépôt ;
 *   - les valeurs absentes — une couverture qui n'a pas pu être mesurée n'est
 *     pas une couverture de zéro, et la peindre ainsi inventerait une chute.
 *
 * Moins de deux points : pas de delta et pas de direction. « Stable » sur un
 * seul point serait une affirmation qu'on ne peut pas faire.
 */
export function tendance(historique, champ, { jours = 30, maintenant = Date.now() } = {}) {
  const depuis = maintenant - jours * JOUR_MS;
  const valeurs = (historique ?? [])
    .filter((h) => h?.declencheur !== 'local' && typeof h?.[champ] === 'number')
    .map((h) => ({ le: h.le, valeur: h[champ], t: Date.parse(h.le) }))
    .filter((v) => Number.isFinite(v.t) && v.t >= depuis && v.t <= maintenant)
    .sort((a, b) => a.t - b.t)
    .map(({ le, valeur }) => ({ le, valeur }));

  if (valeurs.length < 2) return { valeurs, delta: null, direction: null };
  const delta = Number((valeurs.at(-1).valeur - valeurs[0].valeur).toFixed(2));
  return { valeurs, delta, direction: delta > 0 ? 'monte' : delta < 0 ? 'descend' : 'stable' };
}

// ─── Les capacités du produit ─────────────────────────────────────────────────
//
// Un test déclare ce qu'il prouve en écrivant `@cap:<slug>` dans son titre. La
// convention tient pour Vitest comme pour Playwright parce qu'aucun des deux
// n'a besoin de la comprendre : le titre voyage tel quel jusqu'au rapport.

/** Les deux niveaux de preuve. Il n'y en a pas de troisième, et c'est le sujet. */
export const NIVEAUX = ['ecran', 'moteur'];

/**
 * Les capacités qu'un titre revendique, et à QUEL NIVEAU chacune.
 *
 * `@cap:<slug>/ecran` — un parcours navigateur, ou un test de composant ou
 * d'action web. Il prouve que les boutons existent, s'enchaînent et affichent
 * ce qu'il faut.
 *
 * `@cap:<slug>/moteur` — un test du runner, des outils, de l'orchestration ou
 * de la base. Il prouve que la chose EST FAITE, pas qu'elle est affichée.
 *
 * La distinction vient d'une question de Quentin (12/09) : « quand c'est vert,
 * ça veut dire que le runner fonctionne vraiment, ou simplement que cocher les
 * boutons fonctionne ? ». Un seul mot ne pouvait pas répondre, parce que
 * « Donner des outils » était tenue par trois parcours d'ÉCRAN quand les tests
 * qui prouvent la promesse — la whitelist, l'exécution d'un outil — n'étaient
 * étiquetés nulle part.
 *
 * Un titre peut en revendiquer plusieurs — un parcours de bout en bout traverse
 * souvent deux ou trois capacités, et prétendre le contraire forcerait à couper
 * des parcours utiles en morceaux pour satisfaire le registre.
 *
 * Le niveau est OPTIONNEL le temps de la transition : `niveau` vaut alors
 * `null`, et la porte le signale en avertissement. Un suffixe qui n'est ni
 * `ecran` ni `moteur` (une faute de frappe) n'est pas lu comme un niveau — il
 * tombe dans le même `null`, donc sous les yeux de quelqu'un.
 *
 * Le `(?![\w-])` n'est pas décoratif : sans lui, l'alternative s'arrêtait au
 * bon PRÉFIXE et laissait le reste par terre. `@cap:x/ecranXYZ` se déclarait
 * preuve d'écran et `@cap:y/moteur-bis` preuve de moteur — la faute de frappe
 * devenait un niveau, en silence, et le paragraphe ci-dessus mentait. Trouvé
 * par la revue Codex du 13/09, en SONDANT la fonction, pas en la lisant.
 */
export function capacitesDunTitre(titre) {
  return [...String(titre ?? '').matchAll(/@cap:([a-z0-9-]+)(?:\/(ecran|moteur)(?![\w-]))?/g)].map(
    (m) => ({
      slug: m[1],
      niveau: m[2] ?? null,
    }),
  );
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
  // Un test COMMENTÉ n'est plus un test : commenter l'unique preuve d'une
  // capacité la laissait « prouvée » (revue Codex, 3e passe). On retire les
  // blocs `/* … */` et les LIGNES qui commencent par `//` — jamais un `//` en
  // milieu de ligne, qui est le plus souvent le `//` d'une URL dans un titre.
  //
  // Et un bloc ne compte que s'il COMMENCE une ligne. Un `/*` en milieu de
  // ligne est presque toujours un glob dans une chaîne (`tests/e2e/*.spec.ts`)
  // : rejoué sur les 587 fichiers de test du dépôt, le retrait naïf partait de
  // ce glob jusqu'au `*/` suivant, six cents lignes plus loin, et tout ce qui
  // vivait entre les deux disparaissait du scan.
  //
  // Limite assumée : un bloc ouvert en FIN de ligne (`code(); /* it('mort…') */`)
  // n'est pas retiré, et le test qu'il contient est lu comme vivant. Aucune
  // occurrence dans les 588 fichiers de test suivis (revue Codex, 5e passe) ;
  // la lever demanderait un vrai tokenizer, et une regex de plus rouvrirait le
  // cas du glob. Commenter un test, c'est commenter sa ligne.
  const t = String(texte ?? '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
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
 * Ce qu'on SAIT d'une capacité, niveau par niveau.
 *
 * L'ancien `etatDuneCapacite` rendait un mot — « prouvée », « cassée » — et ce
 * mot mentait par omission. « Donner des outils » s'affichait *prouvée* parce
 * que trois parcours d'écran passaient ; les tests qui prouvent la promesse
 * (la whitelist, l'exécution d'un outil) n'étaient étiquetés nulle part. Et
 * *cassée* ne disait pas si c'était le produit ou le navigateur qui avait
 * lâché. Quentin a posé les deux questions le 12/09 ; ce qui suit y répond en
 * faits plutôt qu'en verdict.
 *
 * Pour chaque niveau, un état et rien d'autre :
 *   - `absente`      — aucun test de ce niveau. Ce n'est PAS un échec, et ça ne
 *                      doit jamais s'afficher en rouge : personne n'a écrit la
 *                      preuve, voilà tout ;
 *   - `echouee`      — au moins une preuve a échoué à la dernière mesure. Le
 *                      rouge l'emporte sur le vert DANS SON NIVEAU : une
 *                      capacité tenue par trois écrans dont un tombe a un écran
 *                      cassé, pas « majoritairement vert » ;
 *   - `instable`     — verte et rouge selon les jours ;
 *   - `passee`       — au moins une preuve verte, aucune tombée ;
 *   - `ignoree`      — sautée (`test.skip`) : quelqu'un l'a désactivée, et on
 *                      peut la rouvrir ;
 *   - `jamais jouee` — déclarée dans le dépôt, jamais atteinte par une
 *                      exécution. Deux trous DIFFÉRENTS qu'on ne répare pas
 *                      pareil, là où l'ancien code n'avait qu'un « non jouée ».
 *
 * `nonDit` reçoit les preuves dont l'étiquette ne porte pas de niveau. Les
 * ranger d'office dans « écran » peindrait en vert un moteur que personne n'a
 * testé — exactement le mensonge que ce lot supprime.
 */
const RANG_NIVEAU = ['echouee', 'instable', 'passee', 'ignoree', 'jamais jouee'];

function etatDunNiveau(preuves) {
  if (preuves.length === 0) return 'absente';
  const etats = new Set(
    preuves.map((p) => {
      if (p?.sort === 'rouge') return 'echouee';
      if (p?.sort === 'instable') return 'instable';
      if (p?.sort === 'vert') return 'passee';
      if (p?.sort === 'ignoré') return 'ignoree';
      return 'jamais jouee';
    }),
  );
  return RANG_NIVEAU.find((e) => etats.has(e));
}

export function preuvesDuneCapacite(preuves) {
  const p = preuves ?? [];
  const par = (niveau) => p.filter((x) => x?.niveau === niveau);
  // Tout ce qui n'est ni l'un ni l'autre : `null`, absent, ou un suffixe mal
  // orthographié. L'ordre d'origine est conservé — c'est celui du rapport.
  const out = { nonDit: p.filter((x) => !NIVEAUX.includes(x?.niveau)) };
  for (const n of NIVEAUX) {
    const siennes = par(n);
    out[n] = { etat: etatDunNiveau(siennes), preuves: siennes };
  }
  return out;
}

/** Le mot qu'on affiche pour un état, à l'intérieur d'un niveau. */
export const MOT_ETAT = {
  absente: 'not tested',
  echouee: 'failed',
  instable: 'flaky',
  passee: 'passed',
  ignoree: 'skipped',
  'jamais jouee': 'never run',
};

/**
 * La ligne d'une capacité, en une phrase de deux faits.
 *
 * Jamais un verdict : « écran passé · moteur non testé » dit ce qu'on sait et
 * ce qu'on ignore, là où « prouvée » affirmait les deux.
 */
export function phraseDeCapacite(r) {
  const e = r?.ecran?.etat ?? 'absente';
  const m = r?.moteur?.etat ?? 'absente';
  if (e === 'absente' && m === 'absente') return 'no proof';
  return `screen ${MOT_ETAT[e]} · engine ${MOT_ETAT[m]}`;
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
 * Et une TROISIÈME qui ne bloque pas : une étiquette sans niveau
 * (`@cap:x` au lieu de `@cap:x/ecran`). Elle est rendue avec `bloquant: false`
 * — un avertissement, le temps de la conversion des titres existants. Bloquer
 * dès le premier jour ferait rougir des centaines de titres d'un coup et la
 * porte se ferait désactiver le jour même ; ne rien dire laisserait la moitié
 * du dépôt sans niveau pour toujours. **Temporaire : quand `pnpm
 * capacites:check` n'affiche plus aucun avertissement, ce cas devient
 * bloquant et le `bloquant: false` disparaît.**
 *
 * Ce qu'elle ne refuse PAS, et c'est délibéré : une capacité dont les tests
 * ÉCHOUENT, et une capacité prouvée au seul niveau écran. Cette porte garde le
 * LIEN entre le produit et ses preuves ; la gravité d'un rouge est le sujet de
 * l'issue #65, et « moteur non testé » est un écart qu'on lit sur la page, pas
 * une PR qu'on refuse. Écrire ici qu'elle protège du rouge en ferait une garde
 * imaginaire, exactement ce que ce portail dénonce.
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
      bloquant: true,
      slug,
      origines: [...new Set(origines)].sort(),
    });
  }

  for (const c of registre) {
    if (!c.exigee) continue;
    // La LONGUEUR, pas l'état par niveau : une preuve sans niveau reste une
    // preuve. Sinon le premier commit de la transition ferait tomber les
    // vingt-quatre capacités exigées d'un coup, alors que rien n'a été supprimé.
    const siennes = toutes.filter((p) => p.capacite === c.slug);
    if (siennes.length === 0) {
      fautes.push({
        type: 'capacité exigée sans preuve',
        bloquant: true,
        slug: c.slug,
        nom: c.nom,
      });
    }
  }

  // Avertissement, pas refus. Voir l'en-tête : temporaire.
  for (const c of registre) {
    const sansNiveau = toutes.filter((p) => p.capacite === c.slug && !NIVEAUX.includes(p?.niveau));
    if (sansNiveau.length === 0) continue;
    fautes.push({
      type: 'étiquette sans niveau',
      bloquant: false,
      slug: c.slug,
      origines: [...new Set(sansNiveau.map((p) => p.origine ?? '?'))].sort(),
    });
  }

  return fautes;
}

/**
 * Les preuves d'une capacité, en croisant ce que le dépôt REVENDIQUE et ce que
 * la CI a JOUÉ.
 *
 * Deux sources qui ne disent pas la même chose :
 *   - `declarees` vient d'un scan des titres. Elle vaut pour tout le dépôt,
 *     mais ne sait pas si le test passe ;
 *   - `joues` vient de vrais rapports d'exécution. Elle sait, pour ce qui a
 *     tourné.
 *
 * `joues` est une liste PLATE, parcours et tests unitaires mélangés. La première
 * version ne prenait que les rapports Playwright : les capacités tenues
 * uniquement par de l'unitaire — choisir un modèle, attacher une skill, voir le
 * coût — seraient restées « non jouée » à jamais, et une preuve unitaire rouge
 * n'aurait jamais rougi sa capacité (revue Codex du 11/09).
 *
 * Quand les deux parlent du même couple (fichier, capacité), l'exécution
 * l'emporte et la déclaration disparaît : la garder ferait compter deux fois la
 * même preuve, dont une sans résultat, et une capacité verte s'afficherait
 * éternellement « non jouée » à côté d'elle-même.
 */
export function croiserPreuves({ declarees, joues } = {}) {
  const jouees = [];
  const remplaces = new Set();
  for (const c of joues ?? []) {
    // Dédupliqué DANS le cas : un `describe` étiqueté qui contient un cas
    // étiqueté pareil écrit deux fois la même étiquette dans le titre complet.
    // Sans ce Set, la même vérification comptait pour deux (revue Codex, 13/09).
    const vus = new Set();
    for (const { slug, niveau } of capacitesDunTitre(c.titreComplet ?? c.titre)) {
      const cle = `${slug}::${niveau ?? ''}`;
      if (vus.has(cle)) continue;
      vus.add(cle);
      // Un cas par preuve, jamais un fichier : quand une capacité tombe, la
      // seule information utile est QUEL test exact l'a lâchée.
      jouees.push({ capacite: slug, niveau, origine: c.fichier, titre: c.titre, sort: c.sort });
      // La clé inclut le NIVEAU : un même fichier peut porter un `describe`
      // d'écran et un `describe` de moteur. Effacer sa déclaration sur le seul
      // nom du fichier ferait disparaître le niveau que l'exécution n'a pas
      // joué, et la capacité paraîtrait sans moteur alors que le test existe.
      remplaces.add(`${c.fichier}::${slug}::${niveau ?? ''}`);
    }
  }
  const restantes = (declarees ?? []).filter(
    (d) => !remplaces.has(`${d.origine}::${d.capacite}::${d.niveau ?? ''}`),
  );
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
    const niveaux = preuvesDuneCapacite(siennes);
    // `phrase` est calculée ICI et pas dans le rendu : c'est la ligne que
    // l'écran affiche, et elle se teste.
    return { ...c, ...niveaux, phrase: phraseDeCapacite(niveaux), preuves: siennes };
  });
}

/**
 * La ligne qui TERMINE une déclaration `import`.
 *
 * Deux formes la terminent, et la seconde manquait : le `from` d'un import
 * nommé, et le point-virgule d'un import à effet de bord. `import
 * './helpers.ts';` tient sur une ligne et ne porte aucun `from` ; le drapeau
 * « on est dans un import » restait donc levé jusqu'à la fin du fichier, tout
 * l'en-tête était sauté, et la page Journeys affichait « no description » sous
 * un parcours qui en avait une (revue après coup de la PR #86).
 *
 * Un import sur plusieurs lignes ne peut pas se faire prendre par le
 * point-virgule : entre ses accolades on trouve des virgules, jamais un
 * point-virgule.
 */
const finDImport = (ligne) => /\bfrom\b/.test(ligne) || ligne.endsWith(';');

/**
 * La description d'un parcours : la première phrase UTILE de son fichier.
 *
 * Le cas réel (Quentin, 13/09) : la page Parcours affichait, sous chaque
 * parcours, `── Constants ───────────`. La collecte prenait la première ligne
 * `//` du fichier ; or la plupart des specs ouvrent sur un bloc encadré, et
 * le premier `//` arrive cent lignes plus bas, sur un séparateur décoratif.
 * Une description qui n'est qu'un trait ne dit rien à personne.
 *
 * Trois sources, dans cet ordre :
 *  (a) le bloc de commentaire d'EN-TÊTE — le premier commentaire du fichier,
 *      imports mis à part. Les lignes purement décoratives sont sautées, et la
 *      lecture s'arrête à la première ligne vide : la suite est presque
 *      toujours une liste de scénarios, pas une description ;
 *  (b) à défaut, le titre du premier `describe` ;
 *  (c) à défaut, `null` — et le rendu dit « aucune description », ce qui est
 *      une information, là où un blanc n'en est pas une.
 *
 * Un commentaire qui suit du CODE n'est pas un en-tête : c'est ce qui
 * distingue cette fonction de la regex qu'elle remplace.
 */
export function intentionDunParcours(texte) {
  const lignes = String(texte ?? '').split(/\r?\n/);

  // ── L'en-tête : on saute le vide et les imports, et on s'arrête au premier
  // code. `import … from '…'` tient parfois sur plusieurs lignes ; on reste
  // dedans jusqu'à la fin de la déclaration.
  let i = 0;
  let dansImport = false;
  const brut = [];
  for (; i < lignes.length; i++) {
    const l = lignes[i].trim();
    if (dansImport) {
      if (finDImport(l)) dansImport = false;
      continue;
    }
    if (l === '') continue;
    if (/^import\b/.test(l)) {
      if (!finDImport(l)) dansImport = true;
      continue;
    }
    if (l.startsWith('/*')) {
      for (; i < lignes.length; i++) {
        const m = lignes[i];
        brut.push(
          m
            .replace(/^\s*\/\*+/, '')
            .replace(/\*+\/\s*$/, '')
            .replace(/^\s*\*+/, ''),
        );
        if (/\*+\/\s*$/.test(m.trim())) break;
      }
      break;
    }
    if (l.startsWith('//')) {
      for (; i < lignes.length && lignes[i].trim().startsWith('//'); i++)
        brut.push(lignes[i].trim().replace(/^\/\/+/, ''));
      break;
    }
    break; // du code : il n'y a pas d'en-tête
  }

  const phrase = premierePhrase(brut);
  if (phrase) return phrase;

  const d = String(texte ?? '').match(/\btest\.describe(?:\.\w+)*\s*\(\s*(['"`])([\s\S]*?)\1/);
  if (d) {
    const titre = sansEtiquettes(d[2]);
    if (titre) return couper(titre);
  }
  return null;
}

/** Une ligne qui n'est QUE de la décoration, ou un titre de section encadré de traits. */
function decorative(ligne) {
  const l = ligne.trim();
  if (l === '') return false;
  if (/^[\s\-─═━=*_#·•~+|]+$/.test(l)) return true;
  // Le nom du fichier, seul sur sa ligne : cinq specs ouvrent ainsi. Ce n'est
  // pas une description — c'est déjà la colonne d'à côté.
  if (/^\S+\.(spec|test)\.[a-z]+$/.test(l)) return true;
  // `── Constants ───────` : encadré des deux côtés par un trait. C'est un
  // séparateur de code, pas une phrase.
  return /^[-─═━=]{2,}\s.*\s[-─═━=]{2,}$/.test(l);
}

/** Les lignes utiles consécutives d'un bloc, jointes, nettoyées, coupées. */
function premierePhrase(lignesDuBloc) {
  const utiles = [];
  let commence = false;
  for (const ligne of lignesDuBloc) {
    const l = ligne.trim();
    if (decorative(l)) continue;
    if (l === '') {
      if (commence) break;
      continue;
    }
    commence = true;
    utiles.push(l);
  }
  let t = sansEtiquettes(utiles.join(' '));
  // « oauth-flow.spec.ts — … » : le nom du fichier est déjà la colonne d'à
  // côté, le répéter mange la largeur utile.
  t = t.replace(/^\S+\.(spec|test)\.[a-z]+\s*[—–-]+\s*/, '').trim();
  return t ? couper(t) : null;
}

function sansEtiquettes(s) {
  return String(s)
    .replace(/@cap:[a-z0-9-]+(?:\/[a-z-]+)?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Coupé à ~200 caractères, sur une fin de phrase quand il y en a une. */
function couper(t, max = 200) {
  const fin = /[.!?](?=\s|$)/g;
  let dernier = -1;
  for (const m of t.matchAll(fin)) {
    if (m.index + 1 <= max) dernier = m.index + 1;
    else break;
  }
  if (dernier > 0 && dernier < t.length) return t.slice(0, dernier).trim();
  if (t.length <= max) return t;
  const espace = t.lastIndexOf(' ', max);
  return `${t.slice(0, espace > 0 ? espace : max).trim()}…`;
}

// ─── Le tableau vivant : la part GitHub, rafraîchie seule ────────────────────

/**
 * Repose sur une mesure committée la part que GitHub sait donner en une
 * seconde : le tableau des chantiers et le prix d'une PR.
 *
 * La mesure complète instrumente 34 paquets et joue 30 parcours ; elle ne peut
 * tourner qu'une fois par nuit. Le tableau, lui, vieillit en quelques minutes.
 * Les deux faits ne datent donc plus du même instant, et la page porte les deux
 * dates : `genereLe` pour ce qui a été MESURÉ, `tableauLe` pour ce qui a été LU
 * sur GitHub. Une seule date mentirait sur l'une des deux moitiés.
 *
 * GitHub muet : rien n'est écrasé et la date du tableau ne bouge pas. Un
 * hoquet d'API publierait sinon un portail vide, ou présenterait la liste de la
 * veille comme celle de l'instant.
 */
export function fusionnerTableauGitHub(mesure, frais) {
  if (!mesure || typeof mesure !== 'object') {
    throw new Error('no committed measurement to refresh: run the full collection first');
  }
  const socle = {
    ...mesure,
    tableauLe: mesure.tableauLe ?? mesure.genereLe ?? null,
    // La release vient de npm, pas de GitHub : un GitHub muet n'a aucune raison
    // de figer l'état de publication, et c'est le rafraîchissement horaire qui
    // fait qu'une publication est vue dans l'heure et non la nuit suivante.
    release: frais?.release ?? mesure.release ?? null,
  };
  if (!frais?.chantiers) return socle;
  return {
    ...socle,
    // Le tableau publié ne porte QUE ses cartes — l'état dérivé —, jamais les
    // lignes brutes de GitHub (revue C de la PR #175). Le snapshot est un
    // fichier suivi, donc publié : y déposer les corps des issues et des PR,
    // et depuis #128 les corps des COMMENTAIRES, revenait à republier des
    // milliers de lignes écrites ailleurs, dont un secret cité dans une
    // discussion. Personne ne lisait `issues` ni `pr` : la page ne connaît que
    // `cartes`. La projection est ici, au point d'écriture, pour qu'aucun
    // chemin d'assemblage ne puisse la contourner.
    chantiers: { cartes: frais.chantiers.cartes ?? null },
    // Le prix d'une PR vient du même GitHub, par une requête distincte. Absent,
    // on garde le dernier connu : l'effacer ferait clignoter la page à chaque
    // requête un peu lente.
    prixCi: frais.prixCi ?? socle.prixCi ?? null,
    tableauLe: frais.le,
  };
}

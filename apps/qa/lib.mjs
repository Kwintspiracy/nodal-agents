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
  // Une PR ouverte la ferme (`parPr`, posé par `cartesDuTableau`) : le travail
  // est écrit, il attend sa relecture — pas « en cours » (12/09).
  if (carte.parPr != null) return 'En review';
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
      parPr: couvertes.get(i.number) ?? null,
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
      ci: etatCi(p.statusCheckRollup),
    })),
  ];

  return cartes.map((c) => ({ ...c, colonne: colonneDeCarte(c) }));
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

export function ecartsDe(s, historique = [], maintenant = Date.now()) {
  const out = [];
  if (!s) return out;
  const r = s.resume ?? {};
  const registre = s.capacites?.registre ?? [];
  const mem = s.memoire ?? null;

  // ── Le produit d'abord. Un paquet mal couvert est une question d'ingénieur ;
  // une capacité cassée est une promesse rompue.
  const exigeesCassees = registre.filter((c) => c.exigee && c.etat === 'rouge');
  if (exigeesCassees.length > 0) {
    out.push({
      gravite: 'haute',
      titre: `${exigeesCassees.length} capacité(s) exigée(s) du produit sont cassées`,
      detail: `Le test qui les prouve échoue. Ce ne sont pas des lignes non couvertes : ce sont des choses qu'un utilisateur croit pouvoir faire.`,
      quoi: exigeesCassees.map((c) => c.nom),
    });
  }

  const dorment = registre.filter((c) => c.exigee && c.etat === 'non jouée');
  if (dorment.length > 0) {
    out.push({
      gravite: 'moyenne',
      titre: `${dorment.length} capacité(s) exigée(s) ne sont prouvées que sur le papier`,
      detail: `Un test les revendique, aucune exécution ne l'a joué. La preuve existe et dort — c'est un trou dans la mesure, pas dans le produit.`,
      quoi: dorment.map((c) => c.nom),
    });
  }

  const jamais = registre.filter((c) => c.etat === 'jamais prouvée');
  if (jamais.length > 0) {
    out.push({
      // Basse à dessein : c'est un plan de travail, pas une alerte. La monter
      // en haute noierait les vraies régressions sous une liste qui ne bouge
      // que lentement.
      gravite: 'basse',
      titre: `${jamais.length} capacité(s) sur ${registre.length} ne sont revendiquées par aucun test`,
      detail: `C'est la liste de ce qu'on croit livré. Elle est censée rétrécir.`,
      quoi: jamais.map((c) => c.nom),
    });
  }

  // ── La mémoire. Un test cassé se répare ; un test instable se subit.
  if (mem?.instables > 0) {
    out.push({
      gravite: 'moyenne',
      titre: `${mem.instables} test(s) instables`,
      detail: `Verts et rouges dans leur fenêtre. Aucune exécution isolée ne les dénonce : ils passent pour verts chaque fois qu'ils passent.`,
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
      titre: `${frais.length} test(s) sont passés au rouge dans les deux derniers jours`,
      detail: `Un rouge frais est une régression : quelque chose a bougé, et on sait quand. Un rouge ancien est une dette qu'on a appris à ne plus voir — les deux ne se traitent pas pareil.`,
      quoi: frais.map((e) => e.titre ?? e.cle),
    });
  }

  // ── Le banc. Il DÉTECTE déjà les régressions et les écrit ; il ne manquait
  // que quelqu'un pour les lire.
  const banc = verdictDuBanc(s.banc?.dernierRun);
  if (banc.regressions.length > 0) {
    out.push({
      gravite: 'haute',
      titre: `${banc.regressions.length} section(s) du banc ont RÉGRESSÉ`,
      detail: `Le banc l'a mesuré et l'a écrit. La mesure nocturne l'ignore volontairement pour ne pas s'interrompre — c'est ici que ça se dit.`,
      quoi: banc.regressions,
    });
  }
  if (banc.erreurs.length > 0) {
    out.push({
      gravite: 'haute',
      titre: `${banc.erreurs.length} section(s) du banc n'ont PAS PU tourner`,
      detail: `Une panne, pas un ralentissement. Ces sections ne mesurent plus rien, donc elles ne peuvent plus rien garder.`,
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
      titre: `Le banc n'a laissé aucun rapport`,
      detail: `Il a planté avant d'écrire, ou n'a pas tourné. Aucune de ses sections n'a mesuré quoi que ce soit cette nuit : ce n'est pas un vert, c'est un trou.`,
      quoi: [],
    });
  }

  // ── Le dépôt. Réel, mais jamais au-dessus du produit.
  const nonJoues = (s.parcours ?? []).filter((p) => !p.jouParLaCi);
  if (nonJoues.length > 0) {
    const cas = nonJoues.reduce((a, p) => a + p.cas, 0);
    out.push({
      gravite: 'haute',
      titre: `${nonJoues.length} parcours sur ${r.specsE2e} ne sont jamais joués par la CI`,
      detail: `${cas} cas de test écrits, versionnés, et qu'aucune intégration continue n'exécute. Ce sont les parcours utilisateur — précisément ce qu'une régression casse en premier et qu'un test unitaire ne voit pas.`,
      quoi: nonJoues.map((p) => p.nom),
    });
  }

  const nonMesures = (s.paquets ?? []).filter((p) => !p.couverture && p.tests?.cas > 0);
  if (nonMesures.length > 0) {
    out.push({
      gravite: 'haute',
      titre: `${nonMesures.length} paquets portent des tests dont la couverture n'a jamais été mesurée`,
      detail: `La configuration de couverture existait depuis toujours ; le paquet qui la fait tourner n'était pas installé. Aucun de ces paquets ne peut dire quelle part de son code ses tests traversent.`,
      quoi: nonMesures.map((p) => p.nom),
    });
  }

  const ci = s.ci ?? [];
  if (ci.length > 0 && ci.every((w) => !w.lanceBanc)) {
    out.push({
      gravite: 'haute',
      titre: `Aucun workflow ne lance le banc d'essai`,
      detail: `Le banc sort déjà en erreur sur une régression de métrique — c'est une porte qui fonctionne et que personne ne franchit. Une régression du gate d'approbation peut donc partir en production sans un mot.`,
      quoi: (s.banc?.sections ?? []).map((b) => b.id),
    });
  }

  if (ci.length > 0 && !ci.some((w) => w.lanceCouverture)) {
    out.push({
      gravite: 'moyenne',
      titre: `Aucun workflow ne mesure la couverture`,
      detail: `Sans mesure en continu, la couverture est un chiffre du jour où quelqu'un a pensé à la lancer — pas une propriété du dépôt.`,
      quoi: [],
    });
  }

  const nus = (s.paquets ?? []).filter((p) => p.tests?.cas === 0 && p.tests?.e2e === 0);
  if (nus.length > 0) {
    out.push({
      gravite: 'moyenne',
      titre: `${nus.length} paquets sans aucun test`,
      detail: `Un paquet sans test n'est pas forcément un problème — certains ne portent que des types ou de la configuration. Ceux-là méritent d'être nommés pour qu'on cesse de se poser la question.`,
      quoi: nus.map((p) => p.nom),
    });
  }

  if ((historique ?? []).length < 2) {
    out.push({
      gravite: 'basse',
      titre: `L'historique commence tout juste`,
      detail: `${(historique ?? []).length} collecte(s) enregistrée(s). Les questions « combien de fois ça tourne » et « à quelle régularité » deviennent répondables dès que la CI collecte à chaque exécution.`,
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
export function fusionnerEssais(existants, nouveaux, { max = 30, le = null } = {}) {
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
    for (const slug of capacitesDunTitre(c.titreComplet ?? c.titre)) {
      // Un cas par preuve, jamais un fichier : quand une capacité tombe, la
      // seule information utile est QUEL test exact l'a lâchée.
      jouees.push({ capacite: slug, origine: c.fichier, titre: c.titre, sort: c.sort });
      remplaces.add(`${c.fichier}::${slug}`);
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

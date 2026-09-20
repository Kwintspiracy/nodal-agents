#!/usr/bin/env node
// apps/qa/collect.mjs — rassemble TOUT ce que le dépôt sait de sa propre qualité.
//
// Produit `apps/qa/data/snapshot.json`, la photo d'un instant, et APPEND une
// ligne à `apps/qa/data/history.ndjson` — c'est cette seconde écriture qui
// permet au portail de répondre « combien de fois ça tourne, à quelle
// régularité ». Un rendu statique ne le saura jamais ; un historique, si.
//
// Rien n'est saisi à la main. Ce qui n'est pas mesurable est rendu ABSENT,
// jamais estimé : un portail qui invente un chiffre ne vaut pas mieux que pas
// de portail.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  cartesDuTableau,
  fusionnerEtats,
  croiserPreuves,
  regrouperParCapacite,
  fautesDuRegistre,
  fusionnerEssais,
  prixDeLaCi,
  instabiliteDe,
  regressionsFraiches,
  dureesDeReparation,
  fusionnerTableauGitHub,
  etatDeLaRelease,
  lectureDeNpm,
  commitsDepuisLeTag,
  etatDuDeploiement,
  HORS_MESURE,
  etatDeMesure,
  repartitionDeLaMesure,
} from './lib.mjs';
import { ciDuDepot, parcoursDuDepot } from './depot.mjs';
import { CAPACITES } from './capacites.mjs';
import { revendicationsDuDepot } from './porte.mjs';

// `--github-only` : ne relit que GitHub, et repose le résultat sur la mesure
// nocturne committée. C'est ce mode que le déploiement des pages lance à chaque
// issue et à chaque pull request, pour que le tableau ne date pas de 03:17.
// Il n'écrit NI l'historique NI la mémoire des tests : aucun test n'a tourné.
const GITHUB_SEUL = process.argv.includes('--github-only');

// `--hors-mesure` : imprime les paquets volontairement hors de la mesure de
// couverture, un par ligne, et sort. C'est la mesure nocturne qui l'appelle
// pour les sauter. Sans ce chemin, le workflow tiendrait sa propre liste en
// dur et rien ne garantirait qu'elle dise la même chose que le portail (#58).
if (process.argv.includes('--hors-mesure')) {
  const noms = Object.keys(HORS_MESURE);
  if (noms.length > 0) console.log(noms.join('\n'));
  process.exit(0);
}

const ICI = dirname(fileURLToPath(import.meta.url));
const RACINE = join(ICI, '..', '..');
const DATA = join(ICI, 'data');

// ─── petits utilitaires ───────────────────────────────────────────────────────

const sh = (cmd, opts = {}) => {
  try {
    return execSync(cmd, {
      cwd: RACINE,
      encoding: 'utf8',
      maxBuffer: 1e8,
      stdio: ['ignore', 'pipe', 'ignore'],
      ...opts,
    }).trim();
  } catch {
    return '';
  }
};

const lireJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

/** Les fichiers SUIVIS par git — jamais le disque, qui porte des restes de branches. */
const suivis = () => sh('git ls-files').split('\n').filter(Boolean);

// ─── 1. Les paquets du workspace ──────────────────────────────────────────────

function paquets() {
  const out = [];
  for (const base of ['apps', 'packages', join('packages', 'adapters')]) {
    const dir = join(RACINE, base);
    if (!existsSync(dir)) continue;
    for (const nom of readdirSync(dir)) {
      const chemin = join(dir, nom);
      if (!statSync(chemin).isDirectory()) continue;
      const pkg = lireJson(join(chemin, 'package.json'));
      if (!pkg?.name) continue;
      if (base === 'packages' && nom === 'adapters') continue;
      out.push({ nom: pkg.name, chemin: relative(RACINE, chemin).split(sep).join('/') });
    }
  }
  return out.sort((a, b) => a.nom.localeCompare(b.nom));
}

// ─── 2. Tests : fichiers et cas, par paquet ───────────────────────────────────

const EST_TEST = (f) => /\.(test|spec)\.(ts|tsx|mts|mjs)$/.test(f);

function tests(listePaquets, fichiers) {
  const parPaquet = new Map(
    listePaquets.map((p) => [p.chemin, { fichiers: 0, cas: 0, e2e: 0, casE2e: 0 }]),
  );
  for (const f of fichiers) {
    if (!EST_TEST(f)) continue;
    const p = listePaquets.find((x) => f.startsWith(x.chemin + '/'));
    if (!p) continue;
    const bucket = parPaquet.get(p.chemin);
    let texte = '';
    try {
      texte = readFileSync(join(RACINE, f), 'utf8');
    } catch {
      continue;
    }
    // `it(` / `test(` en tête de ligne — la même règle partout, y compris
    // `.each`, `.skip`, `.only`, pour que le compte soit comparable.
    const cas = (texte.match(/^\s*(it|test)(\.\w+)*\s*\(/gm) ?? []).length;
    const estE2e = f.includes('/tests/e2e/');
    if (estE2e) {
      bucket.e2e += 1;
      bucket.casE2e += cas;
    } else {
      bucket.fichiers += 1;
      bucket.cas += cas;
    }
  }
  return parPaquet;
}

// ─── 3. Couverture réelle (v8), quand elle a été mesurée ──────────────────────
//
// ABSENTE ≠ zéro. Un paquet non mesuré est marqué `null` et le portail le dit :
// c'est un trou dans la MESURE, pas dans le code.

function couverture(listePaquets) {
  const out = {};
  for (const p of listePaquets) {
    const s = lireJson(join(RACINE, p.chemin, 'coverage', 'coverage-summary.json'));
    if (!s?.total) {
      out[p.nom] = null;
      continue;
    }
    const pct = (k) =>
      typeof s.total[k]?.pct === 'number' ? Number(s.total[k].pct.toFixed(2)) : null;
    out[p.nom] = {
      instructions: pct('statements'),
      branches: pct('branches'),
      fonctions: pct('functions'),
      lignes: pct('lines'),
      lignesCouvertes: s.total.lines?.covered ?? null,
      lignesTotal: s.total.lines?.total ?? null,
      fichiersMesures: Object.keys(s).filter((k) => k !== 'total').length,
    };
  }
  return out;
}

/**
 * Les mesures qui ont ÉTÉ TENTÉES et qui ont échoué.
 *
 * La mesure nocturne lance un `vitest --coverage` par paquet et continue sur
 * échec — sinon un paquet cassé priverait le portail des trente-trois autres
 * chiffres. Mais jusqu'ici elle continuait EN SILENCE : le paquet disparaissait
 * de la couverture exactement comme s'il n'avait jamais été instrumenté, et
 * l'issue #58 a mis quatre semaines à poser la question « pourquoi auth ».
 *
 * Elle laisse désormais un témoin dans `coverage/mesure-echouee.json`, à côté
 * de la couverture et donc ignoré par git. Un témoin trouvé ici, c'est une
 * panne qui a un nom et un code de sortie, plus un trou anonyme.
 */
function echecsDeMesure(listePaquets) {
  const out = {};
  for (const p of listePaquets) {
    const m = lireJson(join(RACINE, p.chemin, 'coverage', 'mesure-echouee.json'));
    if (!m) continue;
    out[p.nom] = { code: typeof m.code === 'number' ? m.code : null };
  }
  return out;
}

// ─── 4. Le banc : baselines acceptées + verdict du dernier run ────────────────

function banc() {
  const dir = join(RACINE, 'bench', 'baselines');
  // `attendu` : la mesure nocturne lance TOUJOURS le banc avant de collecter,
  // donc un rapport absent en CI est une panne, pas une omission. En local,
  // personne ne le lance avant `pnpm collect` et son absence ne dit rien —
  // c'est la différence entre un trou de mesure et un dépôt neuf (revue
  // Codex, 3e passe, contre une décision antérieure qui ne distinguait pas).
  const attendu = process.env['GITHUB_ACTIONS'] === 'true';
  if (!existsSync(dir)) return { sections: [], dernierRun: null, attendu };
  const sections = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const b = lireJson(join(dir, f));
      return (
        b && {
          id: b.sectionId ?? f.replace('.json', ''),
          gitSha: b.gitSha ?? null,
          accepteeLe: b.acceptedAt ?? null,
          metriques: (b.metrics ?? []).map((m) => ({
            id: m.id,
            label: m.label,
            valeur: m.value,
            unite: m.unit ?? null,
            sens: m.direction ?? null,
          })),
        }
      );
    })
    .filter(Boolean);
  return { sections, dernierRun: lireJson(join(DATA, 'bench-run.json')), attendu };
}

// ─── 5. Ce que la CI exécute VRAIMENT ─────────────────────────────────────────
//
// La question de Quentin — « qu'est-ce qui les déclenche » — se lit dans les
// workflows, pas dans une intention. On lit les fichiers.

const ci = (fichiers, tousLesParcours) => ciDuDepot(fichiers, tousLesParcours, RACINE);

// ─── 6. Les parcours e2e : versionnés vs joués ────────────────────────────────

const parcours = (fichiers, workflows) =>
  parcoursDuDepot(fichiers, workflows, {
    racine: RACINE,
    resultats: lireJson(join(DATA, 'playwright-run.json')),
  });

// ─── 7. Chantiers : issues et PR, depuis GitHub ───────────────────────────────

function chantiers() {
  const j = (cmd) => {
    const out = sh(cmd);
    if (!out) return null;
    try {
      return JSON.parse(out);
    } catch {
      return null;
    }
  };
  // Deux requêtes par famille, jamais une seule `--state all` bornée : la
  // borne portait sur TOUS les états, et cinquante PR fermées récentes
  // auraient évincé une PR ouverte plus ancienne — disparue de « En review »
  // sans un mot (revue Codex, 3e passe). L'ouvert est demandé en entier, le
  // fermé seulement pour ce qui vient d'être fait.
  // `body` sur les issues aussi : c'est là que se lit la PROVENANCE — le pied
  // que les agents posent, et la section `## Verified` qu'ils doivent porter.
  // Le corps ne va pas dans le snapshot, seuls les deux verdicts qu'on en tire.
  // `closedAt` : la date à laquelle une carte a été FINIE. La colonne « Done »
  // se lisait par numéro décroissant, donc par ordre d'ouverture : les cartes
  // fermées d'un jour chargé chassaient les PR mergées du même jour hors des
  // huit places (#176). Un ordre chronologique demande une chronologie.
  // `milestone` : la release à laquelle une carte appartient (#177). Le jalon
  // existe sur GitHub — les PR de la 0.8.10 le portent — et le tableau ne le
  // rendait nulle part : « ce qui constitue la 0.8.10 » ne se lisait donc que
  // sur GitHub, une carte à la fois. Un champ de plus sur la requête qui tourne
  // déjà ; seul son TITRE voyage jusqu'au snapshot.
  const CHAMPS_ISSUE = 'number,title,state,labels,createdAt,updatedAt,closedAt,milestone,url,body';
  // `body` : c'est là que « Closes #n » vit — sans lui le tableau ne peut pas
  // savoir qu'une issue a sa PR.
  // `comments` : c'est là que vit l'état de la revue (#128), une passe par
  // commentaire dans la forme que `reviewState` lit. Un champ de plus sur la
  // requête qui existe déjà, et non un appel par PR : `gh pr list` les rend
  // avec le reste. Comme le corps, ils ne vont pas dans le snapshot — seul
  // l'état qu'on en tire voyage.
  const CHAMPS_PR =
    'number,title,state,isDraft,createdAt,updatedAt,mergedAt,closedAt,milestone,url,body,comments,statusCheckRollup';
  const deuxEtats = (famille, champs, limiteFermes) =>
    fusionnerEtats(
      j(`gh ${famille} list --state open --limit 1000 --json ${champs}`),
      j(`gh ${famille} list --state closed --limit ${limiteFermes} --json ${champs}`),
    );
  const issues = deuxEtats('issue', CHAMPS_ISSUE, 100);
  const pr = deuxEtats('pr', CHAMPS_PR, 50);

  // `null` et non `[]` quand une requête n'a pas abouti. Le collecteur écrivait
  // `?? []` : dans la mesure nocturne, où `gh` tournait sans jeton, les deux
  // requêtes échouaient et le portail publiait chaque nuit un Kanban VIDE
  // par-dessus le vrai, sans un mot (revue Codex du 11/09).
  const cartes = cartesDuTableau({ issues, pr });
  if (!cartes) {
    console.warn('[qa] GitHub did not answer, the board is marked MISSING, not empty.');
    return null;
  }

  // Les CARTES seules repartent d'ici : les lignes brutes ont servi à les
  // construire et n'ont plus rien à faire dans un fichier suivi (revue C de la
  // PR #175). Personne ne les lisait — la page ne connaît que `cartes` —, et
  // elles portaient les corps des issues, des PR, et depuis #128 ceux des
  // commentaires. `fusionnerTableauGitHub` reprojette de son côté : deux
  // ceintures, parce qu'un secret republié ne se retire pas de l'historique.
  return { cartes };
}

// ─── 7 ter. L'état de la release, DEMANDÉ, jamais raconté ─────────────────────
//
// Le 12/09/2026 une issue « Publish 0.8.9 » a vécu quatre jours sur ce tableau
// alors que 0.8.9 était sur npm depuis le 09/09. Personne n'avait de quoi la
// contredire. Le portail interroge donc npm et git lui-même, à chaque collecte,
// et l'écrit dans le snapshot.

/** Comme `sh`, mais stderr CAPTURÉ au lieu d'être jeté. */
const DIT_TOUT = {
  cwd: RACINE,
  encoding: 'utf8',
  maxBuffer: 1e8,
  stdio: ['ignore', 'pipe', 'pipe'],
};

/**
 * `npm view`, stderr COMPRIS : c'est là que le registre dit `E404`, et ce code
 * est toute la différence entre « jamais publié » et « npm n'a pas répondu ».
 */
function interrogerNpm() {
  try {
    return { sortie: execSync('npm view nodal-agents version time --json', DIT_TOUT) };
  } catch (err) {
    return { sortie: err?.stdout ?? '', erreur: `${err?.stderr ?? ''} ${err?.message ?? ''}` };
  }
}

function release() {
  const { etat, npm } = lectureDeNpm(interrogerNpm());
  if (etat === 'injoignable') {
    console.warn('[qa] npm did not answer, the release state is MISSING, not green.');
  }
  if (etat === 'jamais-publiee') {
    console.warn('[qa] npm answered: nodal-agents is NOT published yet.');
  }

  const dernierTag = sh('git describe --tags --abbrev=0 --match "v*"') || null;
  const versionDuDepot = lireJson(join(RACINE, 'apps', 'cli', 'package.json'))?.version ?? null;

  return etatDeLaRelease({
    npm,
    etatNpm: etat,
    depot: {
      version: versionDuDepot,
      dernierTag,
      commitsDepuisLeTag: dernierTag
        ? commitsDepuisLeTag({
            surLaBranchePubliee: sh(`git rev-list --count ${dernierTag}..origin/main`),
            surHead: sh(`git rev-list --count ${dernierTag}..HEAD`),
          })
        : null,
    },
    le: new Date().toISOString(),
  });
}

// ─── 7 bis. Ce qu'une PR coûte en contrôles ───────────────────────────────────

/**
 * Les trente dernières exécutions de la CI sur une PR.
 *
 * `--event pull_request` et rien d'autre : une exécution sur `push` ne fait
 * attendre personne devant son merge, et la mélanger ferait une moyenne qui ne
 * décrit aucune situation vécue.
 *
 * `null` — jamais `[]` — quand `gh` n'a pas répondu, et DIT à voix haute, comme
 * `chantiers()`. Une absence de mesure n'est pas une CI gratuite, et c'est
 * précisément le genre de zéro silencieux que ce portail existe pour refuser.
 */
function prixCi() {
  const champs = 'databaseId,createdAt,updatedAt,conclusion,headBranch,url';
  const out = sh(
    `gh run list --workflow ci.yml --event pull_request --status completed --limit 30 --json ${champs}`,
  );
  let runs = null;
  if (out) {
    try {
      runs = JSON.parse(out);
    } catch {
      runs = null;
    }
  }
  if (!runs) {
    console.warn('[qa] GitHub did not answer on runs, the price of a pull request is MISSING.');
    return null;
  }
  return prixDeLaCi(runs);
}

// ─── 7 quater. Le déploiement des docs et du portail ──────────────────────────

/**
 * Les trente derniers runs de `docs.yml`, réduits à ce qu'ils disent du site :
 * quand il a été déployé pour la dernière fois, et ce qui est arrivé aux runs
 * partis depuis.
 *
 * Le 20/09/2026 le déploiement de `main` a été ANNULÉ par GitHub — un second
 * run mis en file la même seconde, dans le même groupe — et rien ne l'a dit
 * (#306). Chaque run construit `main` HEAD, donc un run annulé est remplacé
 * par celui qui l'a annulé ; ce qui reste à voir, c'est un remplacement qui
 * n'a pas eu lieu. La lecture est ici, l'arithmétique dans `lib.mjs`.
 *
 * `null` — jamais un état inventé — quand `gh` n'a pas répondu, et DIT.
 */
function deploiement() {
  const champs = 'databaseId,status,conclusion,event,createdAt,updatedAt,headSha,url';
  const out = sh(`gh run list --workflow docs.yml --limit 30 --json ${champs}`);
  let runs = null;
  if (out) {
    try {
      runs = JSON.parse(out);
    } catch {
      runs = null;
    }
  }
  if (!runs) {
    console.warn('[qa] GitHub did not answer on the docs deploys, the deploy state is MISSING.');
    return null;
  }
  return etatDuDeploiement(runs);
}

/**
 * L'exécution qui a produit cette collecte, et son adresse.
 *
 * C'est le chemin de retour : un rouge dans le portail mène au run qui l'a vu,
 * donc au rapport, aux traces et aux captures d'écran. Sans lui, chaque nom de
 * test rouge est un cul-de-sac — on sait QUE ça casse, jamais ce que
 * l'utilisateur aurait vu.
 *
 * `null` en local : il n'y a pas de run à montrer, et un lien inventé serait
 * pire qu'aucun lien.
 */
function execution() {
  const id = process.env['GITHUB_RUN_ID'] ?? null;
  if (!id) return null;
  let depot = null;
  try {
    depot = JSON.parse(sh('gh repo view --json nameWithOwner') || 'null')?.nameWithOwner ?? null;
  } catch {
    depot = null;
  }
  // Le dépôt vient aussi de l'environnement d'Actions : `gh` peut échouer, pas
  // `GITHUB_REPOSITORY`.
  depot = depot ?? process.env['GITHUB_REPOSITORY'] ?? null;
  return { id, url: depot ? `https://github.com/${depot}/actions/runs/${id}` : null };
}

// ─── 8. Les capacités du produit, et ce qui les prouve ────────────────────────
//
// La seule section qui parle du PRODUIT et non du dépôt. « @nodal-agents/web à
// 78 % » ne dit rien à personne ; « est-ce qu'un utilisateur peut connecter
// Notion, et qu'est-ce qui le prouve » est la question qu'on se pose vraiment.

function capacites(fichiers, joues) {
  // Ce que le dépôt REVENDIQUE : un scan textuel des titres, qui vaut pour les
  // tests unitaires comme pour les parcours.
  const declarees = revendicationsDuDepot(fichiers, (f) => readFileSync(join(RACINE, f), 'utf8'));

  // `joues` porte les parcours ET les suites unitaires. Ne passer que les
  // premiers laissait « choisir un modèle » ou « voir le coût » éternellement
  // non jouées, alors que leurs tests tournent chaque nuit.
  const preuves = croiserPreuves({ declarees, joues });

  return {
    registre: regrouperParCapacite({ capacites: CAPACITES, preuves }),
    fautes: fautesDuRegistre({ capacites: CAPACITES, preuves }),
  };
}

// ─── 9. La mémoire, test par test ─────────────────────────────────────────────
//
// `history.ndjson` garde des TOTAUX par collecte : ils ne sauront jamais dire
// « ce test a tourné 47 fois, échoué 3 fois, toujours sous Windows ». Un
// enregistrement par test, mis à jour à chaque collecte, le sait — et reste
// borné là où une ligne par test et par exécution ajouterait six mille lignes
// chaque nuit.

const SORT_VITEST = { passed: 'vert', failed: 'rouge', skipped: 'ignoré', pending: 'ignoré' };

/** Les cas joués lors de CETTE collecte : parcours e2e et suites unitaires. */
function essaisDeLaCollecte(e2e, listePaquets) {
  const essais = [];

  for (const p of e2e) {
    for (const c of p.resultat?.cas ?? []) {
      essais.push({
        fichier: p.fichier,
        titre: c.titreComplet ?? c.titre,
        sort: c.sort,
        dureeMs: c.dureeMs ?? null,
      });
    }
  }

  // Les rapports unitaires, paquet par paquet — jamais à la racine, où un run
  // unique fait tomber des centaines de tests pour une raison étrangère au
  // code (chaque paquet porte son environnement). ABSENT ≠ vide : un paquet
  // sans rapport n'apporte simplement aucun essai.
  for (const p of listePaquets) {
    const rapport = lireJson(join(RACINE, p.chemin, 'tests-run.json'));
    for (const fichier of rapport?.testResults ?? []) {
      const rel = relative(RACINE, fichier.name ?? '')
        .split(sep)
        .join('/');
      for (const cas of fichier.assertionResults ?? []) {
        const sort = SORT_VITEST[cas.status];
        if (!sort) continue;
        essais.push({
          fichier: rel,
          titre: cas.fullName ?? cas.title,
          sort,
          dureeMs: cas.duration ?? null,
        });
      }
    }
  }

  return essais;
}

function memoire(essais, le, execution) {
  const chemin = join(DATA, 'tests.ndjson');
  const existants = existsSync(chemin)
    ? readFileSync(chemin, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];

  const fusionnes = fusionnerEssais(existants, essais, { le, execution });

  // Une ligne par test, triée : le diff nocturne reste lisible à l'œil.
  writeFileSync(chemin, fusionnes.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const avecVerdict = fusionnes.map((e) => ({ ...e, ...instabiliteDe(e) }));
  return {
    total: fusionnes.length,
    // Combien de temps un test reste cassé quand il finit par être réparé. Le
    // chiffre qui manquait : « 22 rouges » ne dit pas si on répare en un jour
    // ou jamais.
    reparations: dureesDeReparation(fusionnes),
    joues: essais.length,
    instables: avecVerdict.filter((e) => e.verdict === 'instable').length,
    casses: avecVerdict.filter((e) => e.verdict === 'cassé').length,
    // Les plus nuisibles d'abord : ceux qui tombent sans être franchement
    // cassés. Un test cassé se répare ; un test instable se subit.
    pires: avecVerdict
      .filter((e) => e.verdict === 'instable')
      .sort((a, b) => b.tauxEchec - a.tauxEchec)
      .slice(0, 20),
    // Ce qui est rouge MAINTENANT et dont la bascule a été vue — quel que soit
    // le verdict d'instabilité. Un test qui passait hier a un historique `vr`,
    // donc « instable » : le chercher parmi les cassés le laissait passer.
    regressions: regressionsFraiches(avecVerdict).sort((a, b) =>
      String(b.rougeDepuis ?? '').localeCompare(String(a.rougeDepuis ?? '')),
    ),
    // Les cassés, du plus ancien au plus récent : l'âge d'un rouge dit s'il
    // s'agit d'une régression de la nuit ou d'une dette qu'on a appris à ne
    // plus voir.
    listeCasses: avecVerdict
      .filter((e) => e.verdict === 'cassé')
      .sort((a, b) => String(a.rougeDepuis ?? '').localeCompare(String(b.rougeDepuis ?? '')))
      .slice(0, 30),
  };
}

// ─── Assemblage ───────────────────────────────────────────────────────────────

/** Le mode `--github-only` : la part lue sur GitHub, reposée sur la mesure. */
function rafraichirGitHub() {
  const chemin = join(DATA, 'snapshot.json');
  const frais = {
    chantiers: chantiers(),
    prixCi: prixCi(),
    release: release(),
    deploiement: deploiement(),
    le: new Date().toISOString(),
  };
  const snapshot = fusionnerTableauGitHub(lireJson(chemin), frais);
  writeFileSync(chemin, JSON.stringify(snapshot, null, 2));
  const n = snapshot.chantiers?.cartes?.length ?? 0;
  console.log(
    frais.chantiers
      ? `board refreshed: ${n} cards read on GitHub at ${snapshot.tableauLe} (measurement of ${snapshot.genereLe} kept)`
      : `board NOT refreshed: GitHub stayed silent, the committed board of ${snapshot.tableauLe} is served as is`,
  );
}

function main() {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
  if (GITHUB_SEUL) return rafraichirGitHub();

  const fichiers = suivis();
  const listePaquets = paquets();
  const parPaquet = tests(listePaquets, fichiers);
  const cov = couverture(listePaquets);
  const echecs = echecsDeMesure(listePaquets);
  const nomsParcours = fichiers
    .filter((f) => f.startsWith('apps/web/tests/e2e/') && f.endsWith('.spec.ts'))
    .map((f) => f.split('/').pop());
  const workflows = ci(fichiers, nomsParcours);
  const e2e = parcours(fichiers, workflows);
  // Une seule liste d'essais, calculée une fois : la mémoire test-par-test et
  // l'évaluation des capacités regardent EXACTEMENT les mêmes résultats. Deux
  // chemins séparés, c'était la porte ouverte à ce qu'une capacité ignore une
  // suite que la mémoire, elle, comptait.
  const essais = essaisDeLaCollecte(e2e, listePaquets);
  const cap = capacites(fichiers, essais);
  const genereLe = new Date().toISOString();
  const exec = execution();
  const mem = memoire(essais, genereLe, exec?.url ?? null);

  // `mesure` porte POURQUOI la couverture manque, quand elle manque. Sans
  // elle, une exclusion assumée et un trou de mesure sont la même ligne vide,
  // et c'est ce que le portail affichait (#58).
  const paquetsEnrichis = listePaquets.map((p) => {
    const echec = echecs[p.nom] ?? null;
    const base = {
      ...p,
      tests: parPaquet.get(p.chemin) ?? { fichiers: 0, cas: 0, e2e: 0, casE2e: 0 },
      couverture: cov[p.nom] ?? null,
      ...(echec ? { mesureEchouee: echec } : {}),
    };
    return { ...base, mesure: etatDeMesure(base) };
  });
  const repMesure = repartitionDeLaMesure(paquetsEnrichis);

  const totalCas = paquetsEnrichis.reduce((n, p) => n + p.tests.cas, 0);
  const totalFichiers = paquetsEnrichis.reduce((n, p) => n + p.tests.fichiers, 0);
  const mesures = paquetsEnrichis.filter((p) => p.couverture);
  // Moyenne PONDÉRÉE par les lignes, pas moyenne des pourcentages : un paquet
  // de 60 lignes ne pèse pas autant qu'un de 6 000.
  const lignesCouvertes = mesures.reduce((n, p) => n + (p.couverture.lignesCouvertes ?? 0), 0);
  const lignesTotal = mesures.reduce((n, p) => n + (p.couverture.lignesTotal ?? 0), 0);

  const snapshot = {
    genereLe,
    // Le tableau est relu bien plus souvent que la mesure : les deux dates
    // partent d'ici ensemble, puis `--github-only` fait avancer la seconde.
    tableauLe: genereLe,
    // Le run qui a produit cette collecte. C'est par lui qu'un rouge du portail
    // mène au rapport et aux captures d'écran ; `null` en local, jamais inventé.
    execution: exec,
    commit: sh('git rev-parse HEAD').slice(0, 8) || null,
    branche: sh('git rev-parse --abbrev-ref HEAD') || null,
    paquets: paquetsEnrichis,
    resume: {
      paquets: paquetsEnrichis.length,
      fichiersDeTest: totalFichiers,
      casDeTest: totalCas,
      specsE2e: e2e.length,
      casE2e: e2e.reduce((n, s) => n + s.cas, 0),
      specsE2eJoueesParLaCi: e2e.filter((s) => s.jouParLaCi).length,
      paquetsMesures: mesures.length,
      // Deux clés NEUVES à côté de `paquetsMesures`, qui garde son sens pour
      // l'historique. La différence `paquets - paquetsMesures` ne disait pas
      // si le reste était un choix ou une panne.
      paquetsExclus: repMesure.exclues.length,
      paquetsSansMesure: repMesure.echouees.length + repMesure.absentes.length,
      lignesCouvertes,
      lignesTotal,
      couvertureLignes:
        lignesTotal > 0 ? Number(((lignesCouvertes / lignesTotal) * 100).toFixed(2)) : null,
      capacites: cap.registre.length,
      // Clés NEUVES, et pas `capacitesProuvees` recalculée : l'historique
      // porte l'ancienne depuis des semaines, avec l'ancien sens (« un test
      // étiqueté passe », tous niveaux confondus). Réutiliser le nom ferait
      // une courbe dont la moitié gauche ne mesure pas la même chose que la
      // droite, et personne ne le verrait jamais.
      capacitesVerifiees: cap.registre.filter(
        (c) => c.ecran.etat === 'passee' && c.moteur.etat === 'passee',
      ).length,
      capacitesSansMoteur: cap.registre.filter((c) => c.moteur.etat === 'absente').length,
      capacitesSansPreuve: cap.registre.filter(
        (c) => c.ecran.etat === 'absente' && c.moteur.etat === 'absente' && c.nonDit.length === 0,
      ).length,
      testsEnMemoire: mem.total,
      testsInstables: mem.instables,
      testsCasses: mem.casses,
    },
    capacites: cap,
    memoire: mem,
    banc: banc(),
    ci: workflows,
    // À côté de `ci` et non dedans : `ci` est la LISTE des workflows, et y
    // glisser une clé en ferait un tableau qui porte un objet — la première
    // chose qu'un lecteur comprendrait de travers.
    prixCi: prixCi(),
    parcours: e2e,
    chantiers: chantiers(),
    // Ce que npm sert VRAIMENT, face à ce que le dépôt porte. Le seul fait qui
    // pouvait contredire l'issue #68, et qui manquait.
    release: release(),
    // Quand le site a été déployé pour la dernière fois, et ce qui est arrivé
    // aux runs depuis (#306).
    deploiement: deploiement(),
  };

  writeFileSync(join(DATA, 'snapshot.json'), JSON.stringify(snapshot, null, 2));

  // L'historique : une ligne par collecte. C'est lui, et lui seul, qui permet
  // de dire « ça tourne N fois, à telle régularité ».
  appendFileSync(
    join(DATA, 'history.ndjson'),
    JSON.stringify({
      le: snapshot.genereLe,
      commit: snapshot.commit,
      branche: snapshot.branche,
      declencheur: process.env['GITHUB_EVENT_NAME'] ?? 'local',
      execution: process.env['GITHUB_RUN_ID'] ?? null,
      ...snapshot.resume,
    }) + '\n',
  );

  const r = snapshot.resume;
  console.log(
    `snapshot: ${r.paquets} packages · ${r.casDeTest} cases · ${r.specsE2e} journeys (${r.specsE2eJoueesParLaCi} in CI)`,
  );
  const nomme = (liste) => (liste.length > 0 ? ` (${liste.map((p) => p.nom).join(', ')})` : '');
  console.log(
    `coverage: ${r.paquetsMesures}/${r.paquets} packages measured · ${r.couvertureLignes ?? '·'}% of the measured lines · ` +
      `${r.paquetsExclus} left out on purpose${nomme(repMesure.exclues)} · ` +
      `${r.paquetsSansMesure} with no measurement${nomme([...repMesure.echouees, ...repMesure.absentes])}`,
  );
  console.log(
    `capabilities: ${r.capacites} named · ${r.capacitesVerifiees} verified at both levels · ${r.capacitesSansMoteur} without an engine · ${r.capacitesSansPreuve} with no proof at all`,
  );
  const rel = snapshot.release;
  console.log(
    rel.npmInjoignable
      ? `release: npm unreachable at ${rel.verifieLe} · repo at ${rel.versionDuDepot ?? '·'}`
      : `release: npm serves ${rel.surNpm} (${rel.publieeLe ?? 'date unknown'}) · repo at ${rel.versionDuDepot} · ${rel.commitsDepuisLeTag ?? '·'} commits since ${rel.dernierTag ?? 'no tag'}`,
  );
  console.log(
    `memory: ${r.testsEnMemoire} tests tracked (${mem.joues} played this time) · ${r.testsInstables} flaky · ${r.testsCasses} broken`,
  );
}

main();

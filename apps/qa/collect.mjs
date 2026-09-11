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
  sortDuCas,
  compterParcours,
  parcoursDunWorkflow,
  declencheursDunWorkflow,
  cadenceDe,
  croiserPreuves,
  regrouperParCapacite,
  fautesDuRegistre,
  fusionnerEssais,
  instabiliteDe,
  regressionsFraiches,
} from './lib.mjs';
import { CAPACITES } from './capacites.mjs';
import { revendicationsDuDepot } from './porte.mjs';

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

function ci(fichiers, tousLesParcours) {
  const wfs = fichiers.filter((f) => f.startsWith('.github/workflows/') && /\.ya?ml$/.test(f));
  return wfs.map((f) => {
    const texte = readFileSync(join(RACINE, f), 'utf8');
    const jobs = [...texte.matchAll(/^ {2}([a-z0-9_-]+):\s*$/gim)].map((m) => m[1]);
    const declencheurs = declencheursDunWorkflow(texte);
    const parcours = parcoursDunWorkflow(texte, tousLesParcours);
    return {
      fichier: f,
      nom: (texte.match(/^name:\s*(.+)$/m)?.[1] ?? f).trim().replace(/^['"]|['"]$/g, ''),
      declencheurs,
      jobs,
      // Un workflow qui BALAIE les parcours en joue autant qu'un qui les
      // nomme — ne lire que les noms littéraux laissait le portail annoncer
      // « 2 en CI » pour toujours (revue Codex, PR #51).
      specsNommees: parcours.joues,
      balayeLesParcours: parcours.balaye,
      parcoursExclus: parcours.exclus ?? [],
      cadence: cadenceDe(declencheurs),
      lanceBanc: /pnpm bench|@nodal-agents\/bench/.test(texte),
      lanceCouverture: /--coverage/.test(texte),
    };
  });
}

// ─── 6. Les parcours e2e : versionnés vs joués ────────────────────────────────

function parcours(fichiers, workflows) {
  const specs = fichiers.filter(
    (f) => f.startsWith('apps/web/tests/e2e/') && f.endsWith('.spec.ts'),
  );
  // Qui joue quoi, et à quelle cadence. Un parcours joué chaque nuit n'est pas
  // joué à chaque PR : les confondre, c'est appeler « couvert » un parcours qui
  // ne garde aucune PR.
  const cadenceParParcours = new Map();
  for (const w of workflows) {
    for (const nom of w.specsNommees) {
      const dejaVue = cadenceParParcours.get(nom);
      // « chaque PR » est la cadence la plus forte : elle l'emporte.
      if (dejaVue === 'chaque PR') continue;
      cadenceParParcours.set(nom, w.cadence);
    }
  }

  const resultats = lireJson(join(DATA, 'playwright-run.json'));
  const parFichier = new Map();
  if (resultats?.suites) {
    // `chemin` accumule les titres des `describe` traversés. Sans lui, seul le
    // titre du cas est connu — or une étiquette `@cap:` posée sur le describe
    // vaut pour tous ses cas, et c'est la façon la moins verbeuse de
    // l'écrire. La perdre reviendrait à exiger une étiquette par cas.
    const marcher = (suites, chemin = [], niveau = 0) => {
      for (const s of suites ?? []) {
        const f = s.file ? `apps/web/tests/e2e/${s.file}` : null;
        // Le niveau 0 est le FICHIER : son titre est le nom du fichier, déjà
        // porté par `fichier`. L'inclure doublerait chaque clé de la mémoire.
        const ici = niveau > 0 && s.title ? [...chemin, s.title] : chemin;
        for (const spec of s.specs ?? []) {
          if (!f) continue;
          const essais = (spec.tests ?? []).flatMap((t) => t.results ?? []);
          // Quatre sorts, gardés séparés : `vert`, `rouge`, `ignoré`,
          // `instable`. Les écraser en un booléen faisait passer 36 cas
          // IGNORÉS pour des régressions (revue Codex, PR #51) — le défaut même
          // que ce portail dénonce ailleurs.
          const sort = sortDuCas(essais);
          const duree = essais.reduce((n, r) => n + (r.duration ?? 0), 0);
          const b = parFichier.get(f) ?? { sorts: [], dureeMs: 0, cas: [] };
          b.sorts.push(sort);
          b.dureeMs += duree;
          b.cas.push({
            titre: spec.title,
            titreComplet: [...ici, spec.title].join(' '),
            sort,
            dureeMs: duree,
          });
          parFichier.set(f, b);
        }
        marcher(s.suites, ici, niveau + 1);
      }
    };
    marcher(resultats.suites);
  }
  return specs.map((f) => {
    const nom = f.split('/').pop();
    const brut = parFichier.get(f) ?? null;
    const r = brut
      ? { ...compterParcours(brut.sorts), dureeMs: brut.dureeMs, cas: brut.cas }
      : null;
    let texte = '';
    try {
      texte = readFileSync(join(RACINE, f), 'utf8');
    } catch {
      /* le fichier est suivi mais absent de cette branche */
    }
    return {
      fichier: f,
      nom,
      cas: (texte.match(/^\s*test(\.\w+)*\s*\(/gm) ?? []).length,
      jouParLaCi: cadenceParParcours.has(nom),
      cadence: cadenceParParcours.get(nom) ?? null,
      resultat: r,
      // La première ligne de commentaire du fichier, quand il y en a une :
      // c'est ce que l'auteur a jugé utile de dire du parcours.
      intention: (texte.match(/^\/\/\s*(.+)$/m)?.[1] ?? '').trim() || null,
    };
  });
}

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
  const CHAMPS_ISSUE = 'number,title,state,labels,createdAt,updatedAt,url';
  // `body` : c'est là que « Closes #n » vit — sans lui le tableau ne peut pas
  // savoir qu'une issue a sa PR.
  const CHAMPS_PR =
    'number,title,state,isDraft,createdAt,updatedAt,mergedAt,url,body,statusCheckRollup';
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
    console.warn('[qa] GitHub sans réponse — le tableau est marqué ABSENT, pas vide.');
    return null;
  }

  return { issues, pr, cartes };
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

function memoire(essais, le) {
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

  const fusionnes = fusionnerEssais(existants, essais, { le });

  // Une ligne par test, triée : le diff nocturne reste lisible à l'œil.
  writeFileSync(chemin, fusionnes.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const avecVerdict = fusionnes.map((e) => ({ ...e, ...instabiliteDe(e) }));
  return {
    total: fusionnes.length,
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

function main() {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });

  const fichiers = suivis();
  const listePaquets = paquets();
  const parPaquet = tests(listePaquets, fichiers);
  const cov = couverture(listePaquets);
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
  const mem = memoire(essais, genereLe);

  const paquetsEnrichis = listePaquets.map((p) => ({
    ...p,
    tests: parPaquet.get(p.chemin) ?? { fichiers: 0, cas: 0, e2e: 0, casE2e: 0 },
    couverture: cov[p.nom] ?? null,
  }));

  const totalCas = paquetsEnrichis.reduce((n, p) => n + p.tests.cas, 0);
  const totalFichiers = paquetsEnrichis.reduce((n, p) => n + p.tests.fichiers, 0);
  const mesures = paquetsEnrichis.filter((p) => p.couverture);
  // Moyenne PONDÉRÉE par les lignes, pas moyenne des pourcentages : un paquet
  // de 60 lignes ne pèse pas autant qu'un de 6 000.
  const lignesCouvertes = mesures.reduce((n, p) => n + (p.couverture.lignesCouvertes ?? 0), 0);
  const lignesTotal = mesures.reduce((n, p) => n + (p.couverture.lignesTotal ?? 0), 0);

  const snapshot = {
    genereLe,
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
      lignesCouvertes,
      lignesTotal,
      couvertureLignes:
        lignesTotal > 0 ? Number(((lignesCouvertes / lignesTotal) * 100).toFixed(2)) : null,
      capacites: cap.registre.length,
      capacitesProuvees: cap.registre.filter((c) => c.etat === 'prouvée').length,
      capacitesJamaisProuvees: cap.registre.filter((c) => c.etat === 'jamais prouvée').length,
      testsEnMemoire: mem.total,
      testsInstables: mem.instables,
      testsCasses: mem.casses,
    },
    capacites: cap,
    memoire: mem,
    banc: banc(),
    ci: workflows,
    parcours: e2e,
    chantiers: chantiers(),
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
    `snapshot: ${r.paquets} paquets · ${r.casDeTest} cas · ${r.specsE2e} parcours (${r.specsE2eJoueesParLaCi} en CI)`,
  );
  console.log(
    `couverture: ${r.paquetsMesures}/${r.paquets} paquets mesurés · ${r.couvertureLignes ?? '—'}% des lignes mesurées`,
  );
  console.log(
    `capacités: ${r.capacites} nommées · ${r.capacitesProuvees} prouvées · ${r.capacitesJamaisProuvees} jamais prouvées`,
  );
  console.log(
    `mémoire: ${r.testsEnMemoire} tests suivis (${mem.joues} joués cette fois) · ${r.testsInstables} instables · ${r.testsCasses} cassés`,
  );
}

main();

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
  etatCi,
  colonneDeCarte,
  sortDuCas,
  compterParcours,
  parcoursDunWorkflow,
  declencheursDunWorkflow,
  cadenceDe,
  croiserPreuves,
  regrouperParCapacite,
  fautesDuRegistre,
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
  if (!existsSync(dir)) return { sections: [], dernierRun: null };
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
  return { sections, dernierRun: lireJson(join(DATA, 'bench-run.json')) };
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
    const marcher = (suites, chemin = []) => {
      for (const s of suites ?? []) {
        const f = s.file ? `apps/web/tests/e2e/${s.file}` : null;
        const ici = s.title ? [...chemin, s.title] : chemin;
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
        marcher(s.suites, ici);
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
    try {
      return JSON.parse(out);
    } catch {
      return null;
    }
  };
  const issues =
    j(
      'gh issue list --state all --limit 200 --json number,title,state,labels,createdAt,updatedAt,url',
    ) ?? [];
  const pr =
    j(
      'gh pr list --state all --limit 50 --json number,title,state,isDraft,createdAt,updatedAt,mergedAt,url,statusCheckRollup',
    ) ?? [];

  const cartes = [
    ...issues.map((i) => ({
      type: 'issue',
      numero: i.number,
      titre: i.title,
      etat: i.state,
      url: i.url,
      etiquettes: (i.labels ?? []).map((l) => l.name),
      majLe: i.updatedAt ?? null,
    })),
    ...pr.map((p) => ({
      type: 'pr',
      numero: p.number,
      titre: p.title,
      etat: p.state,
      url: p.url,
      brouillon: p.isDraft === true,
      etiquettes: [],
      majLe: p.mergedAt ?? p.updatedAt ?? null,
      ci: etatCi(p.statusCheckRollup),
    })),
  ].map((c) => ({ ...c, colonne: colonneDeCarte(c) }));

  return { issues, pr, cartes };
}

// ─── 8. Les capacités du produit, et ce qui les prouve ────────────────────────
//
// La seule section qui parle du PRODUIT et non du dépôt. « @nodal-agents/web à
// 78 % » ne dit rien à personne ; « est-ce qu'un utilisateur peut connecter
// Notion, et qu'est-ce qui le prouve » est la question qu'on se pose vraiment.

function capacites(fichiers, e2e) {
  // Ce que le dépôt REVENDIQUE : un scan textuel des titres, qui vaut pour les
  // tests unitaires comme pour les parcours.
  const declarees = revendicationsDuDepot(fichiers, (f) => readFileSync(join(RACINE, f), 'utf8'));

  const preuves = croiserPreuves({ declarees, e2e });

  return {
    registre: regrouperParCapacite({ capacites: CAPACITES, preuves }),
    fautes: fautesDuRegistre({ capacites: CAPACITES, preuves }),
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
  const cap = capacites(fichiers, e2e);

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
    genereLe: new Date().toISOString(),
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
    },
    capacites: cap,
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
}

main();

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

function ci(fichiers) {
  const wfs = fichiers.filter((f) => f.startsWith('.github/workflows/') && /\.ya?ml$/.test(f));
  return wfs.map((f) => {
    const texte = readFileSync(join(RACINE, f), 'utf8');
    const jobs = [...texte.matchAll(/^ {2}([a-z0-9_-]+):\s*$/gim)].map((m) => m[1]);
    const declencheurs = [];
    if (/^on:/m.test(texte)) {
      if (/\bpush:/.test(texte)) declencheurs.push('push');
      if (/\bpull_request:/.test(texte)) declencheurs.push('pull_request');
      if (/\bschedule:/.test(texte)) declencheurs.push('schedule');
      if (/workflow_dispatch/.test(texte)) declencheurs.push('manuel');
    }
    // Les specs Playwright NOMMÉES dans le workflow : c'est la liste réellement
    // jouée, et l'écart avec les specs versionnées est le trou qu'on cherche.
    const specsNommees = [...texte.matchAll(/tests\/e2e\/([\w.-]+\.spec\.ts)/g)].map((m) => m[1]);
    return {
      fichier: f,
      nom: (texte.match(/^name:\s*(.+)$/m)?.[1] ?? f).trim().replace(/^['"]|['"]$/g, ''),
      declencheurs,
      jobs,
      specsNommees: [...new Set(specsNommees)],
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
  const joues = new Set(workflows.flatMap((w) => w.specsNommees));
  const resultats = lireJson(join(DATA, 'playwright-run.json'));
  const parFichier = new Map();
  if (resultats?.suites) {
    const marcher = (suites) => {
      for (const s of suites ?? []) {
        const f = s.file ? `apps/web/tests/e2e/${s.file}` : null;
        for (const spec of s.specs ?? []) {
          const ok = (spec.tests ?? []).every((t) =>
            (t.results ?? []).every((r) => r.status === 'passed'),
          );
          const duree = (spec.tests ?? [])
            .flatMap((t) => t.results ?? [])
            .reduce((n, r) => n + (r.duration ?? 0), 0);
          if (!f) continue;
          const b = parFichier.get(f) ?? { total: 0, verts: 0, dureeMs: 0, cas: [] };
          b.total += 1;
          if (ok) b.verts += 1;
          b.dureeMs += duree;
          b.cas.push({ titre: spec.title, vert: ok, dureeMs: duree });
          parFichier.set(f, b);
        }
        marcher(s.suites);
      }
    };
    marcher(resultats.suites);
  }
  return specs.map((f) => {
    const nom = f.split('/').pop();
    const r = parFichier.get(f) ?? null;
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
      jouParLaCi: joues.has(nom),
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

  // ── La colonne d'une carte ────────────────────────────────────────────────
  //
  // Déduite de FAITS, jamais saisie : un tableau qu'il faut ranger à la main
  // est un tableau qui ment dès qu'on oublie de le ranger. Ce que GitHub sait
  // déjà — une PR ouverte, une PR mergée, une issue fermée, une étiquette —
  // suffit à placer chaque carte.
  //
  //   Fait      · issue fermée, PR mergée
  //   En review · PR ouverte, c'est sa définition
  //   À tester  · une issue étiquetée `test`
  //   À faire   · une issue étiquetée `décision` — elle attend Quentin
  //   En cours  · le reste des issues ouvertes
  const colonne = (carte) => {
    if (carte.type === 'pr') return carte.etat === 'MERGED' ? 'Fait' : 'En review';
    if (carte.etat !== 'OPEN') return 'Fait';
    if (carte.etiquettes.includes('décision')) return 'À faire';
    if (carte.etiquettes.includes('test')) return 'À tester';
    return 'En cours';
  };

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
      // L'état de la CI tel que GitHub le rend : une PR en review dont les
      // contrôles rougissent n'attend pas la même chose qu'une PR verte.
      ci: (() => {
        const r = p.statusCheckRollup ?? [];
        if (r.length === 0) return null;
        if (r.some((c) => (c.conclusion ?? c.state) === 'FAILURE')) return 'rouge';
        if (r.some((c) => ['IN_PROGRESS', 'QUEUED', 'PENDING'].includes(c.status ?? '')))
          return 'en cours';
        return 'vert';
      })(),
    })),
  ].map((c) => ({ ...c, colonne: colonne(c) }));

  return { issues, pr, cartes };
}

// ─── Assemblage ───────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });

  const fichiers = suivis();
  const listePaquets = paquets();
  const parPaquet = tests(listePaquets, fichiers);
  const cov = couverture(listePaquets);
  const workflows = ci(fichiers);
  const e2e = parcours(fichiers, workflows);

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
    },
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
}

main();

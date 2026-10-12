// turbo-cache-honnete.test.mjs — turbo ne rejoue jamais un verdict dont il ne
// connaît pas les entrées (issue #698).
//
// Turbo met une tâche en cache sous un hash calculé sur les fichiers DU paquet
// (plus ses dépendances déclarées et les `globalDependencies`). Une tâche qui lit
// un fichier HORS de cet ensemble garde le même hash quand ce fichier change, et
// turbo rejoue l'ancien journal. Le 06/10/2026, `@nodal-agents/db:test` a été
// rejoué vert (« cache hit, replaying logs fe36e25b8feed6eb ») sur la PR qui
// corrigeait `apps/runner/src/job/execute.ts`, fichier que son test
// `designated-chat-readers` lit mais que son hash ignore.
//
// Deux règles, une par forme du problème :
//
// 1. `test` n'est JAMAIS mis en cache. Un test lit ce qu'il veut, à l'exécution :
//    les `architecture.test.ts` balaient tout le dépôt, d'autres lisent les
//    sources d'un paquet voisin, les migrations, les workflows, la config vitest
//    de la racine. Aucune liste d'entrées déclarée ne suit cela, et sa dérive est
//    muette — c'est précisément l'incident.
// 2. `build`, `lint` et `typecheck` restent en cache : leurs lectures hors paquet
//    sont connues et MÉCANIQUES — la chaîne `extends` des tsconfig et les imports
//    relatifs des configs ESLint. Ces fichiers doivent figurer dans les
//    `globalDependencies` ; ce test les DÉDUIT des configs réelles plutôt que de
//    recopier une liste.
//
// Lancer depuis la racine : pnpm test:scripts

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const turbo = JSON.parse(readFileSync(join(repoRoot, 'turbo.json'), 'utf-8'));

/** Chemin relatif à la racine, en `/` — la forme des `globalDependencies`. */
function depuisLaRacine(abs) {
  return relative(repoRoot, abs).split(sep).join('/');
}

/** Les dossiers de paquets, lus depuis pnpm-workspace.yaml (globs `<dossier>/*`). */
function paquets() {
  const yaml = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf-8');
  const bloc = /^packages:\s*\n((?:\s+-.*\n)+)/m.exec(yaml);
  if (!bloc) throw new Error('pnpm-workspace.yaml : bloc `packages:` introuvable');
  const dossiers = [];
  for (const m of bloc[1].matchAll(/-\s*'?"?([^'"\s]+)'?"?/g)) {
    if (!m[1].endsWith('/*')) throw new Error(`glob de workspace non géré : ${m[1]}`);
    const parent = join(repoRoot, m[1].slice(0, -2));
    for (const e of readdirSync(parent, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(parent, e.name, 'package.json'))) {
        dossiers.push(join(parent, e.name));
      }
    }
  }
  return dossiers;
}

/** Un tsconfig peut porter des commentaires ; JSON.parse d'abord, sinon on les retire. */
function lireTsconfig(fichier) {
  const texte = readFileSync(fichier, 'utf-8');
  try {
    return JSON.parse(texte);
  } catch {
    return JSON.parse(texte.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
  }
}

/** Tous les fichiers que la chaîne `extends` d'un tsconfig fait lire. */
function chaineTsconfig(fichier, vus = new Set()) {
  if (vus.has(fichier)) return vus;
  vus.add(fichier);
  const { extends: parents } = lireTsconfig(fichier);
  for (const p of [parents ?? []].flat()) {
    // Un `extends` par NOM de paquet est résolu dans node_modules : couvert par
    // le lockfile, que turbo hache déjà.
    if (!p.startsWith('.')) continue;
    chaineTsconfig(resolve(dirname(fichier), p), vus);
  }
  return vus;
}

/** Tous les fichiers qu'une config ESLint importe par chemin relatif, transitivement. */
function chaineEslint(fichier, vus = new Set()) {
  if (vus.has(fichier)) return vus;
  vus.add(fichier);
  const texte = readFileSync(fichier, 'utf-8');
  for (const m of texte.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    chaineEslint(resolve(dirname(fichier), m[1]), vus);
  }
  return vus;
}

const CONFIGS_ESLINT = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs'];

/** La config qu'ESLint lit pour `eslint src` lancé dans `dossier` : la plus proche en remontant. */
function configEslintDe(dossier) {
  for (let d = dossier; ; d = dirname(d)) {
    const trouvee = CONFIGS_ESLINT.map((n) => join(d, n)).find((f) => existsSync(f));
    if (trouvee) return trouvee;
    if (d === repoRoot) throw new Error(`aucune config ESLint au-dessus de ${dossier}`);
  }
}

/** Les fichiers HORS du paquet que ses tâches en cache lisent, d'après ses configs réelles. */
function lecturesHorsPaquet(dossier) {
  const lus = new Set();
  for (const nom of readdirSync(dossier)) {
    if (/^tsconfig.*\.json$/.test(nom)) {
      for (const f of chaineTsconfig(join(dossier, nom))) lus.add(f);
    }
  }
  for (const f of chaineEslint(configEslintDe(dossier))) lus.add(f);
  return [...lus].filter((f) => !f.startsWith(dossier + sep)).map(depuisLaRacine);
}

describe('turbo ne rejoue jamais un verdict dont il ignore les entrées (#698)', () => {
  it('la tâche test n’est jamais mise en cache', () => {
    expect(turbo.tasks.test.cache).toBe(false);
  });

  it('chaque fichier hors paquet lu par build, lint ou typecheck est une globalDependency', () => {
    const declarees = new Set(turbo.globalDependencies ?? []);
    const manquantes = [];
    for (const dossier of paquets()) {
      for (const f of lecturesHorsPaquet(dossier)) {
        if (!declarees.has(f)) manquantes.push(`${depuisLaRacine(dossier)} lit ${f}`);
      }
    }
    expect(manquantes).toEqual([]);
  });

  it('la déduction trouve bien les configs de la racine (sinon la garde ne garde rien)', () => {
    const db = join(repoRoot, 'packages', 'db');
    expect(lecturesHorsPaquet(db)).toEqual(
      expect.arrayContaining(['tsconfig.base.json', 'eslint.config.js', 'eslint.shared.mjs']),
    );
  });
});

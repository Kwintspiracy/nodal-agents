// lint-script-par-paquet.test.mjs — la garde qui aurait vu l'issue #216.
//
// `pnpm lint` est `turbo lint`, et turbo ne lance la tâche `lint` d'un paquet
// que si ce paquet DÉCLARE un script `lint`. Un paquet sans ce script n'est pas
// signalé : turbo le range en `<NONEXISTENT>` et passe. `apps/qa` est resté
// ainsi hors de toute vérification jusqu'au 20/09/2026, avec une erreur ESLint
// dedans que personne ne voyait.
//
// L'assertion porte sur le résultat réel : les manifestes que pnpm-workspace.yaml
// désigne, lus sur le disque. C'est exactement la liste que turbo parcourt — et
// c'est pour cela que les globs sont LUS, jamais recopiés : `packages/adapters/*`
// n'est pas déductible de `packages/*`, et treize adaptateurs y vivent.
//
// Lancer depuis la racine : pnpm test:scripts

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Les globs de `pnpm-workspace.yaml`, dans l'ordre du fichier. Tous sont de la
 * forme `<dossier>/*` aujourd'hui ; une forme inconnue fait rougir le test
 * plutôt que de réduire la liste en silence (invariant #4).
 */
function workspaceGlobs() {
  const yaml = readFileSync(resolve(repoRoot, 'pnpm-workspace.yaml'), 'utf-8');
  const globs = [];
  let dansPackages = false;
  for (const ligne of yaml.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(ligne)) {
      dansPackages = true;
      continue;
    }
    if (dansPackages) {
      const m = /^\s+-\s*'?"?([^'"\s]+)'?"?\s*$/.exec(ligne);
      if (m) {
        globs.push(m[1]);
        continue;
      }
      if (ligne.trim() !== '' && !ligne.startsWith('#')) break;
    }
  }
  return globs;
}

/** Les paquets de l'espace de travail, tels que pnpm et turbo les voient. */
function workspacePackages() {
  const out = [];
  for (const glob of workspaceGlobs()) {
    if (!glob.endsWith('/*')) {
      throw new Error(`glob d'espace de travail non géré par ce test : ${glob}`);
    }
    const dir = resolve(repoRoot, glob.slice(0, -2));
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(dir, entry.name, 'package.json');
      if (!existsSync(manifest)) continue;
      out.push({
        id: `${glob.slice(0, -2)}/${entry.name}`,
        manifest,
        pkg: JSON.parse(readFileSync(manifest, 'utf-8')),
      });
    }
  }
  return out;
}

describe('every workspace package is reachable by `turbo lint`', () => {
  const packages = workspacePackages();

  it('reads the workspace globs and finds the packages behind them', () => {
    // Sans ces deux repères, les assertions suivantes passeraient à vide, ou
    // passeraient en ayant oublié la moitié de l'arbre.
    expect(workspaceGlobs()).toContain('packages/adapters/*');
    expect(packages.map((p) => p.id)).toContain('apps/qa');
    expect(packages.length).toBeGreaterThan(30);
  });

  it('declares a `lint` script in each package manifest', () => {
    const sans = packages.filter((p) => typeof p.pkg.scripts?.lint !== 'string');
    // Le message nomme les coupables : un `expect(n).toBe(0)` ne dirait pas lesquels.
    expect(sans.map((p) => p.id)).toEqual([]);
  });

  it('points each `lint` script at eslint', () => {
    // Un script `lint` qui ne lance pas eslint rendrait la tâche verte sans
    // rien vérifier — c'est le retour silencieux du même trou.
    const horsSujet = packages
      .filter((p) => typeof p.pkg.scripts?.lint === 'string')
      .filter((p) => !p.pkg.scripts.lint.includes('eslint'))
      .map((p) => `${p.id}: ${p.pkg.scripts.lint}`);
    expect(horsSujet).toEqual([]);
  });
});

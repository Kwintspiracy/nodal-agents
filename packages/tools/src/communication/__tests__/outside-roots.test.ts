// outside-roots.test.ts — ce que les helpers de chemin interdit garantissent.
//
// Les tests de confinement (delivery-guard, send-file, send-image, send-media)
// reposent tous sur une seule affirmation : « ce chemin n'est sous aucune
// racine que la garde autorise ». Tant qu'elle était produite par
// `process.cwd()`, elle était fausse dès que le clone vivait sous %TEMP%
// (issue #90). Elle est prouvée ici, une fois, et indépendamment du cwd.
//
// Ce fichier ne bouchonne PAS `node:os` : il vérifie les helpers tels qu'un
// autre fichier de test les obtient.

import { describe, it, expect, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import {
  SYNTHETIC_OUTSIDE_DIR,
  isUnderPath,
  makeFakeTmpRoot,
  makeOutsideDir,
  syntheticOutsideSource,
} from './outside-roots';

const created: string[] = [];
function track(dir: string): string {
  created.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

describe('isUnderPath', () => {
  it('reconnaît le dossier lui-même et ses descendants', () => {
    expect(isUnderPath('/a/b', '/a/b')).toBe(true);
    expect(isUnderPath(path.join('/a/b', 'c', 'd.txt'), '/a/b')).toBe(true);
  });

  it('refuse le voisin qui partage seulement le préfixe de chaîne', () => {
    expect(isUnderPath('/a/b-evil/x', '/a/b')).toBe(false);
  });
});

describe('SYNTHETIC_OUTSIDE_DIR', () => {
  it("n'est sous le dossier temporaire ni égal à lui", () => {
    expect(isUnderPath(SYNTHETIC_OUTSIDE_DIR, tmpdir())).toBe(false);
    expect(isUnderPath(syntheticOutsideSource('outside.md'), tmpdir())).toBe(false);
  });

  it("n'est pas sous le répertoire courant — quel que soit celui-ci", () => {
    // Le cas qui a produit l'issue : un clone SOUS %TEMP%. On ne change pas le
    // cwd du process (vitest le partage entre fichiers) : on vérifie la
    // propriété contre des cwd simulés, dont deux sous tmpdir().
    const cwds = [
      process.cwd(),
      path.join(tmpdir(), 'wt-8990'),
      path.join(tmpdir(), 'wt-8990', 'packages', 'tools'),
      path.join('D:', 'APPS', 'NodalAI'),
      '/home/runner/work/NodalAI/NodalAI',
    ];
    for (const cwd of cwds) {
      expect(isUnderPath(SYNTHETIC_OUTSIDE_DIR, cwd)).toBe(false);
    }
  });

  it('vit directement sous la racine du volume du dossier temporaire', () => {
    // C'est ce qui rend la garantie précédente structurelle : tmpdir() compte
    // au moins un segment de plus que la racine, et ce segment n'est pas
    // celui-ci.
    const root = path.parse(tmpdir()).root;
    expect(path.dirname(SYNTHETIC_OUTSIDE_DIR)).toBe(root);
    expect(path.relative(root, tmpdir()).split(path.sep)[0]).not.toBe(
      path.basename(SYNTHETIC_OUTSIDE_DIR),
    );
  });
});

describe('makeFakeTmpRoot / makeOutsideDir', () => {
  it('rendent deux dossiers réels dont aucun ne contient l’autre', () => {
    // C'est toute la mécanique : le test de confinement fait rendre le premier
    // par un `tmpdir()` bouchonné, et le second devient « hors de toute racine
    // autorisée » — sans jamais écrire hors du dossier temporaire, seul
    // emplacement inscriptible sous le bac à sable de codex.
    const fakeTmp = track(makeFakeTmpRoot('preuve'));
    const outside = track(makeOutsideDir('preuve'));

    expect(statSync(fakeTmp).isDirectory()).toBe(true);
    expect(statSync(outside).isDirectory()).toBe(true);
    expect(isUnderPath(outside, fakeTmp)).toBe(false);
    expect(isUnderPath(fakeTmp, outside)).toBe(false);
  });

  it('rendent un dossier NEUF à chaque appel', () => {
    // Le nom était déterministe dans une première version ; le test de
    // confinement supprimant récursivement ce qu'il reçoit, deux exécutions
    // concurrentes s'effaçaient mutuellement leurs fixtures.
    expect(track(makeOutsideDir('preuve'))).not.toBe(track(makeOutsideDir('preuve')));
  });
});

// release-check-flag.test.mjs — LE DRAPEAU de `release:check`, contre un vrai
// dossier (#296).
//
// POURQUOI CE FICHIER EXISTE. La revue C de la PR #326 a nommé ce qui manquait :
// `scripts/release-check.mjs` n'était couvert par aucun test, et retirer
// l'appel qui pose le drapeau — c'est-à-dire tout le sujet de l'issue — laissait
// les 479 cas du portail verts. Le portail aurait alors montré une bande vide
// pendant les quarante minutes de la commande, exactement l'écran que le
// propriétaire a trouvé inutile le 20/09/2026.
//
// CE QUE CE FICHIER PROUVE :
//   1. le drapeau est ÉCRIT là où le portail le cherche, avec son heure et son
//      dossier ;
//   2. il est RETIRÉ, et le retirer deux fois ne lève pas ;
//   3. le retrait est branché sur la fin normale ET sur les deux signaux —
//      `exit` seul laissait un Ctrl-C poser une bande qui ment pour toujours ;
//   4. le chemin est celui que le collecteur du portail lit, à la lettre.
//
// Mutations vérifiées :
//   - `SIGINT` retiré de `brancherLeRetrait` → le troisième cas rougit ;
//   - le nom du fichier changé → le quatrième rougit (le portail chercherait
//     ailleurs que là où le script écrit).

import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  cheminDuDrapeau,
  poserLeDrapeau,
  retirerLeDrapeau,
  brancherLeRetrait,
} from '../lib/release-check-flag.mjs';

let racine;
const bacs = [];

beforeEach(() => {
  racine = mkdtempSync(join(tmpdir(), 'nodal-drapeau-'));
  bacs.push(racine);
  // Le dossier que le portail lit existe déjà dans un vrai dépôt.
  mkdirSync(join(racine, 'apps', 'qa', 'data'), { recursive: true });
});

afterAll(() => {
  for (const b of bacs) rmSync(b, { recursive: true, force: true });
});

describe('le drapeau de release:check (#296)', () => {
  it('s’écrit là où le portail le cherche, avec son heure et son dossier', () => {
    const quand = new Date('2026-09-20T08:50:00Z');
    expect(poserLeDrapeau(racine, quand)).toBe(true);

    const chemin = cheminDuDrapeau(racine);
    expect(existsSync(chemin), 'le drapeau n’a pas été écrit').toBe(true);
    const lu = JSON.parse(readFileSync(chemin, 'utf8'));
    // L'HEURE DU DÉPART : c'est elle que la bande montre monter vers les
    // quarante minutes.
    expect(lu.depuis).toBe('2026-09-20T08:50:00.000Z');
    // ET LE DOSSIER : la commande se lance aussi depuis un worktree isolé, et
    // on veut savoir lequel travaille.
    expect(lu.ou).toBe(racine.split(/[/\\]/).pop());
  });

  it('se retire, et le retirer deux fois ne lève pas', () => {
    poserLeDrapeau(racine);
    expect(retirerLeDrapeau(racine)).toBe(true);
    expect(existsSync(cheminDuDrapeau(racine))).toBe(false);
    // Le script branche le retrait sur plusieurs sorties : la seconde ne doit
    // pas transformer une fin propre en erreur.
    expect(retirerLeDrapeau(racine)).toBe(true);
  });

  it('le retrait est branché sur la fin normale ET sur les deux signaux', () => {
    // ⚠️ `exit` SEUL NE SUFFIT PAS : Node ne l'émet pas quand le processus est
    // tué par un signal. Un Ctrl-C au milieu des quarante minutes laissait le
    // drapeau, et le portail annonçait « release:check depuis 09:12 » pour
    // toujours — une bande qui ment (revue C de la PR #326).
    const branches = new Map();
    const faux = {
      on: (nom, fn) => branches.set(nom, fn),
      exit: (code) => branches.set('__sortie__', code),
    };
    brancherLeRetrait(racine, faux);
    expect([...branches.keys()].sort()).toEqual(['SIGINT', 'SIGTERM', 'exit']);

    poserLeDrapeau(racine);
    branches.get('SIGINT')();
    expect(existsSync(cheminDuDrapeau(racine)), 'un Ctrl-C a laissé le drapeau').toBe(false);
    // Et l'interruption reste une interruption : un shell qui enchaîne ne doit
    // pas lire un succès.
    expect(branches.get('__sortie__')).toBe(130);

    poserLeDrapeau(racine);
    branches.get('SIGTERM')();
    expect(existsSync(cheminDuDrapeau(racine))).toBe(false);
    expect(branches.get('__sortie__')).toBe(143);

    poserLeDrapeau(racine);
    branches.get('exit')();
    expect(existsSync(cheminDuDrapeau(racine))).toBe(false);
  });

  it('le chemin est celui que le collecteur du portail lit, à la lettre', () => {
    // Les deux côtés doivent nommer le MÊME fichier ; un écart et le portail
    // chercherait un drapeau que personne ne pose.
    const collecteur = readFileSync(new URL('../../apps/qa/collect.mjs', import.meta.url), 'utf8');
    expect(collecteur).toContain("'release-check.running.json'");
    expect(
      cheminDuDrapeau(racine).endsWith(join('apps', 'qa', 'data', 'release-check.running.json')),
    ).toBe(true);
  });
});
